"""Launcher for free Hugging Face Spaces (Gradio SDK runtime).

Docker Spaces are a paid feature, but a Gradio Space is a plain Python
container on free hardware that may start any program. This script installs
Node.js (from the nodejs-wheel pip package), builds UXAudit, downloads
Chromium for Playwright, and then replaces itself with the Node server on the
port the Space expects. System libraries Chromium needs come from packages.txt.
"""

import os
import subprocess
import sys

from nodejs_wheel.executable import ROOT_DIR

APP_DIR = os.path.dirname(os.path.abspath(__file__))
NODE_BIN = os.path.join(ROOT_DIR, "bin")
PORT = os.environ.get("PORT", "7860")


def run(*args: str) -> None:
    print("+", " ".join(args), flush=True)
    subprocess.run(list(args), cwd=APP_DIR, check=True)


def main() -> None:
    env = dict(os.environ)
    env["PATH"] = NODE_BIN + os.pathsep + env.get("PATH", "")
    env.setdefault("NODE_ENV", "production")
    env.setdefault("TRUST_PROXY", "1")
    env["PORT"] = PORT
    os.environ.update(env)

    node = os.path.join(NODE_BIN, "node")
    # The package's npm/npx shims resolve their own paths wrongly; run the CLIs through node directly.
    npm_cli = os.path.join(ROOT_DIR, "lib", "node_modules", "npm", "bin", "npm-cli.js")
    npx_cli = os.path.join(ROOT_DIR, "lib", "node_modules", "npm", "bin", "npx-cli.js")

    if not os.path.exists(os.path.join(APP_DIR, "dist", "main.js")):
        run(node, npm_cli, "ci", "--include=dev", "--no-audit", "--no-fund")
        run(node, npm_cli, "run", "build")
        run(node, npm_cli, "prune", "--omit=dev")
    run(node, npx_cli, "playwright", "install", "chromium")

    print(f"starting UXAudit on port {PORT}", flush=True)
    sys.stdout.flush()
    os.execve(node, [node, os.path.join(APP_DIR, "dist", "main.js")], env)


if __name__ == "__main__":
    main()
