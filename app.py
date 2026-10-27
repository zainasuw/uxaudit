"""Launcher for free Hugging Face Spaces (Gradio SDK runtime).

Docker Spaces are a paid feature, but a Gradio Space is a plain Python
container on free hardware that may start any program. This script installs
Node.js (from the nodejs-wheel pip package), builds UXAudit, downloads
Chromium for Playwright, starts the Node server on an internal port, and then
serves the Space's public port with a small relay in front of it. System
libraries Chromium needs come from packages.txt.

ZeroGPU Spaces refuse to start unless some function is marked @spaces.GPU, so
one is declared here. UXAudit never uses a GPU and never calls it.
"""

import os
import subprocess
import sys
import threading
import time

from nodejs_wheel.executable import ROOT_DIR

try:
    import spaces  # present on ZeroGPU hardware only
except Exception:  # CPU hardware: nothing to declare
    spaces = None


def _gpu_probe() -> str:
    return "unused"


if spaces is not None:
    _gpu_probe = spaces.GPU(_gpu_probe)  # type: ignore[assignment]

APP_DIR = os.path.dirname(os.path.abspath(__file__))
NODE_BIN = os.path.join(ROOT_DIR, "bin")
PUBLIC_PORT = int(os.environ.get("PORT", "7860"))
INTERNAL_PORT = PUBLIC_PORT + 10  # Gradio reserves PUBLIC_PORT + 1 for itself


def run(*args: str) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run(list(args), cwd=APP_DIR, check=True)


def start_node() -> subprocess.Popen:
    env = dict(os.environ)
    env["PATH"] = NODE_BIN + os.pathsep + env.get("PATH", "")
    env.setdefault("NODE_ENV", "production")
    # Node listens on loopback only, behind the relay below, which forwards exactly one
    # X-Forwarded-For value (the address the Space's edge proxy saw), so it is trusted here.
    env["TRUST_PROXY"] = "1"
    env["PORT"] = str(INTERNAL_PORT)
    env["HOST"] = "127.0.0.1"

    node = os.path.join(NODE_BIN, "node")
    # The package's npm/npx shims resolve their own paths wrongly; run the CLIs through node directly.
    npm_cli = os.path.join(ROOT_DIR, "lib", "node_modules", "npm", "bin", "npm-cli.js")
    npx_cli = os.path.join(ROOT_DIR, "lib", "node_modules", "npm", "bin", "npx-cli.js")

    if not os.path.exists(os.path.join(APP_DIR, "dist", "main.js")):
        run(node, npm_cli, "ci", "--include=dev", "--no-audit", "--no-fund")
        run(node, npm_cli, "run", "build")
        run(node, npm_cli, "prune", "--omit=dev")
    run(node, npx_cli, "playwright", "install", "chromium")

    print(f"starting UXAudit on internal port {INTERNAL_PORT}", flush=True)
    return subprocess.Popen([node, os.path.join(APP_DIR, "dist", "main.js")], cwd=APP_DIR, env=env)


def wait_for_node(proc: subprocess.Popen, timeout: float = 120) -> None:
    import socket

    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit(f"UXAudit exited early with code {proc.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", INTERNAL_PORT), timeout=1):
                return
        except OSError:
            time.sleep(0.5)
    raise SystemExit("UXAudit did not start listening in time")


def serve_relay(proc: subprocess.Popen) -> None:
    """Forwards every request on the public port to the Node server.

    The Space's edge proxy appends the real client address as the LAST
    X-Forwarded-For entry, which is what the Node server reads (TRUST_PROXY).
    The relay forwards that header untouched and never adds its own hop, so a
    client cannot choose its own address. Paths are forwarded byte-for-byte,
    request bodies are capped, and responses stream through.
    """
    import httpx
    import uvicorn
    from fastapi import FastAPI, Request, Response
    from fastapi.responses import StreamingResponse
    from starlette.background import BackgroundTask

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    client = httpx.AsyncClient(timeout=httpx.Timeout(190.0))
    skip_request = {"host", "content-length", "connection", "transfer-encoding", "x-real-ip", "forwarded"}
    skip_response = {"content-encoding", "transfer-encoding", "connection", "content-length"}
    max_body = 2 * 1024 * 1024  # the Node server itself accepts at most 16 KB of JSON

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"])
    async def relay(path: str, request: Request) -> Response:
        # Read the body incrementally so a chunked request cannot bypass the cap.
        chunks = []
        received = 0
        async for chunk in request.stream():
            received += len(chunk)
            if received > max_body:
                return Response("Request body too large.", status_code=413, media_type="text/plain")
            chunks.append(chunk)
        body = b"".join(chunks)

        headers = {k: v for k, v in request.headers.items() if k.lower() not in skip_request}
        # The edge proxy appends the real client as the last X-Forwarded-For entry; pass on
        # exactly that one value (or the socket peer when absent) so nothing else can be trusted.
        forwarded = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
        headers["x-forwarded-for"] = forwarded[-1] if forwarded else (request.client.host if request.client else "unknown")

        # Forward the request target exactly as received, but only ever as a path on the
        # internal server: a target like //host/... must not become an absolute URL.
        raw_path = request.scope.get("raw_path", b"/").decode("latin-1") or "/"
        if not raw_path.startswith("/") or raw_path.startswith("//") or "\\" in raw_path:
            return Response("Bad request.", status_code=400, media_type="text/plain")
        query = request.scope.get("query_string", b"").decode("latin-1")
        target = f"http://127.0.0.1:{INTERNAL_PORT}" + raw_path + (f"?{query}" if query else "")
        try:
            upstream_request = client.build_request(request.method, target, content=body, headers=headers)
            upstream = await client.send(upstream_request, stream=True)
        except httpx.HTTPError:
            return Response("UXAudit is starting or restarting. Try again in a moment.", status_code=503, media_type="text/plain")
        response_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in skip_response}
        return StreamingResponse(
            upstream.aiter_raw(),
            status_code=upstream.status_code,
            headers=response_headers,
            media_type=upstream.headers.get("content-type"),
            background=BackgroundTask(upstream.aclose),
        )

    def watch() -> None:
        proc.wait()
        print(f"UXAudit exited with code {proc.returncode}; stopping the relay", flush=True)
        os._exit(1)

    threading.Thread(target=watch, daemon=True).start()

    try:
        import gradio as gr
    except Exception:
        gr = None

    if gr is None:
        uvicorn.run(app, host="0.0.0.0", port=PUBLIC_PORT, log_level="warning", proxy_headers=False)
        return

    # ZeroGPU hosts only accept a Gradio app whose events use a @spaces.GPU
    # function, so a token Gradio app owns the server; the relay is inserted
    # ahead of Gradio's routes and therefore answers every request itself.
    from starlette.routing import Route

    with gr.Blocks() as demo:
        button = gr.Button("unused")
        output = gr.Textbox()
        button.click(_gpu_probe, None, output)
    demo.launch(prevent_thread_lock=True, server_name="0.0.0.0", server_port=PUBLIC_PORT, quiet=True, ssr_mode=False)
    server_app = demo.server_app
    relay_route = [r for r in app.router.routes if isinstance(r, Route)][0]
    server_app.router.routes.insert(0, relay_route)
    print("gradio host active; relay mounted first", flush=True)
    while True:
        time.sleep(3600)


def main() -> None:
    proc = start_node()
    wait_for_node(proc)
    print(f"relaying public port {PUBLIC_PORT} -> {INTERNAL_PORT}", flush=True)
    sys.stdout.flush()
    serve_relay(proc)


if __name__ == "__main__":
    main()
