import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeUrl, AnalyzeError, closeBrowser, type AuditResult } from "./analyze.js";
import { createStore, type AuditSummary, type Store } from "./store.js";
import { parseTargetUrl, type Lookup } from "./url-guard.js";

export interface ServerOptions {
  port?: number;
  host?: string;
  storeDir?: string;
  /** Tests only. Never set from the CLI. */
  allowPrivate?: boolean;
  lookup?: Lookup;
  log?: (message: string) => void;
}

export interface JobState {
  id: string;
  status: "queued" | "running" | "done" | "error";
  stage: string;
  url: string;
  startedAt: string;
  error?: { message: string; kind: string };
  result?: AuditResult;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackHost(u.host);
  } catch {
    return false;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) throw new HttpError(415, "Send JSON.");
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "Body is not valid JSON.");
  }
}

export async function startServer(opts: ServerOptions = {}) {
  const log = opts.log ?? (() => undefined);
  const store: Store = await createStore(opts.storeDir);
  const jobs = new Map<string, JobState>();
  let queue: Promise<unknown> = Promise.resolve();

  function runJob(job: JobState): void {
    queue = queue
      .then(async () => {
        job.status = "running";
        job.stage = "Checking the address";
        try {
          const { result, screenshots } = await analyzeUrl(job.url, {
            allowPrivate: opts.allowPrivate,
            lookup: opts.lookup,
            onStage: (stage) => {
              job.stage = stage;
            },
          });
          await store.save(job.id, result, screenshots);
          job.status = "done";
          job.stage = "Done";
          job.result = result;
          log(`audited ${result.finalUrl}: ${result.checks.filter((c) => c.status === "fail").length} failed checks`);
        } catch (err) {
          job.status = "error";
          job.stage = "Failed";
          job.error = err instanceof AnalyzeError
            ? { message: err.message, kind: err.kind }
            : { message: err instanceof Error ? err.message : String(err), kind: "failed" };
          log(`audit failed for ${job.url}: ${job.error.message}`);
        }
      })
      .catch(() => undefined);
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!isAllowedOrigin(req.headers.origin)) throw new HttpError(403, "Cross-origin requests are not allowed.");
    const method = req.method ?? "GET";
    const [head, id, sub, name] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

    if (head === "audits" && !id && method === "POST") {
      const body = await readJson(req);
      const input = typeof body.url === "string" ? body.url : "";
      // Validate the shape now so an obviously bad address fails immediately.
      try {
        parseTargetUrl(input, { allowPrivate: opts.allowPrivate });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      const job: JobState = { id: store.newId(), status: "queued", stage: "Waiting", url: input.trim(), startedAt: new Date().toISOString() };
      jobs.set(job.id, job);
      runJob(job);
      return json(res, 202, { id: job.id, status: job.status });
    }

    if (head === "audits" && !id && method === "GET") {
      const list: AuditSummary[] = await store.list();
      return json(res, 200, list);
    }

    if (head === "audits" && id && !sub && method === "GET") {
      const job = jobs.get(id);
      if (job) return json(res, 200, job);
      const stored = await store.get(id);
      if (!stored) throw new HttpError(404, "Audit not found.");
      return json(res, 200, { id, status: "done", stage: "Done", url: stored.requestedUrl, startedAt: stored.capturedAt, result: stored } satisfies JobState);
    }

    if (head === "audits" && id && !sub && method === "DELETE") {
      jobs.delete(id);
      if (!(await store.remove(id))) throw new HttpError(404, "Audit not found.");
      return json(res, 200, { ok: true });
    }

    if (head === "audits" && id && sub === "images" && name && method === "GET") {
      const file = store.imagePath(id, name);
      const info = file ? await stat(file).catch(() => null) : null;
      if (!file || !info?.isFile()) throw new HttpError(404, "Image not found.");
      res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=3600" });
      res.end(await readFile(file));
      return;
    }

    throw new HttpError(404, `No route for ${method} ${url.pathname}`);
  }

  async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(403, "Forbidden");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(await readFile(file));
  }

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return json(res, 400, { error: "Malformed request URL." });
    }
    if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: "UXAudit only answers requests addressed to localhost." });
    const handler = url.pathname.startsWith("/api") ? api(req, res, url) : serveStatic(url.pathname, res);
    handler.catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      json(res, 500, { error: "Something went wrong on the server." });
    });
  });

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 3131, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${host}:${port}/`,
    port,
    store,
    jobs,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeBrowser();
    },
  };
}
