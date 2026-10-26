import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeUrl, AnalyzeError, closeBrowser, type AuditResult } from "./analyze.js";
import { startEgressProxy, type EgressProxy } from "./egress-proxy.js";
import { loadInstruction, requestReview, ReviewError, type Review } from "./review.js";
import { createStore, type Store } from "./store.js";
import { parseTargetUrl, type Lookup } from "./url-guard.js";

export interface Limits {
  /** Audits (captures) one client may start per day. */
  auditsPerClientPerDay: number;
  /** AI reviews one client may request per day. */
  reviewsPerClientPerDay: number;
  /** AI reviews for everyone per day; keep below the provider's free quota. */
  reviewsPerDay: number;
  /** Jobs allowed to wait in the queue. */
  queueMax: number;
  /** Hours an audit is kept before deletion. */
  retentionHours: number;
  /** Audits kept at most, oldest deleted first. */
  maxStoredAudits: number;
}

export const DEFAULT_LIMITS: Limits = {
  auditsPerClientPerDay: 25,
  reviewsPerClientPerDay: 5,
  reviewsPerDay: 480,
  queueMax: 10,
  retentionHours: 1,
  maxStoredAudits: 100,
};

export interface ServerOptions {
  port?: number;
  host?: string;
  storeDir?: string;
  /** Host names this server may be addressed as (Host header / Origin). Loopback is always allowed. */
  allowedHosts?: string[];
  /** Behind a reverse proxy, read the client address from X-Forwarded-For. */
  trustProxy?: boolean;
  geminiApiKey?: string;
  geminiModel?: string;
  limits?: Partial<Limits>;
  chromiumSandbox?: boolean;
  /** Tests only: hostnames allowed to resolve to loopback. */
  allowPrivateHosts?: string[];
  lookup?: Lookup;
  reviewFetch?: typeof fetch;
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
  review?: ReviewState;
}

/** Server-side only: which client started a job. Never sent to the browser. */
const jobClients = new WeakMap<JobState, string>();

export interface ReviewState {
  status: "queued" | "running" | "done" | "error";
  error?: { message: string; kind: string };
  result?: Review;
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
  ".jpg": "image/jpeg",
};
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "no-store",
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const hostOf = (header: string | undefined) => (header ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);
/** Keep terminal control characters and anything secret-looking out of log lines. */
const scrubLog = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/AIza[0-9A-Za-z_-]+/g, "[key]").slice(0, 300);

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new HttpError(413, "Request body too large.");
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

/** Per-client daily counters, kept in memory (one process) and reset at the first request of a new day. */
class DailyCounter {
  private counts = new Map<string, number>();
  private day = today();
  private roll(): void {
    const now = today();
    if (now !== this.day) {
      this.day = now;
      this.counts.clear();
    }
  }
  get(key: string): number {
    this.roll();
    return this.counts.get(key) ?? 0;
  }
  increment(key: string): number {
    this.roll();
    const next = this.get(key) + 1;
    this.counts.set(key, next);
    return next;
  }
}

export async function startServer(opts: ServerOptions = {}) {
  const log = opts.log ?? (() => undefined);
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const allowedHosts = new Set([...LOOPBACK, ...(opts.allowedHosts ?? []).map((h) => hostOf(h))]);
  const store: Store = await createStore(opts.storeDir);
  const proxy: EgressProxy = await startEgressProxy({
    allowPrivate: opts.allowPrivateHosts?.includes("*"),
    allowPrivateHosts: opts.allowPrivateHosts,
    lookup: opts.lookup,
    log: (m) => log(`egress: ${m}`),
  });
  const loaded = opts.geminiApiKey ? await loadInstruction() : null;
  const instruction = loaded?.text ?? null;
  if (opts.geminiApiKey && !instruction) {
    log("AI review disabled: no review instruction found (set REVIEW_INSTRUCTION or REVIEW_INSTRUCTION_FILE).");
  }
  const reviewEnabled = !!opts.geminiApiKey && !!instruction;

  const jobs = new Map<string, JobState>();
  const clientAudits = new DailyCounter();
  const clientReviews = new DailyCounter();
  const clientPending = new Map<string, number>();
  let queued = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;

  function clientOf(req: http.IncomingMessage): string {
    if (opts.trustProxy) {
      // The trusted reverse proxy appends the real client address LAST; earlier
      // entries are whatever the client chose to send and cannot be trusted.
      const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const last = forwarded.at(-1);
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function requireHostAndOrigin(req: http.IncomingMessage): void {
    if (!allowedHosts.has(hostOf(req.headers.host))) throw new HttpError(403, "This server does not answer for that host name.");
    const origin = req.headers.origin;
    if (origin === undefined) return;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, "Cross-origin requests are not allowed.");
    }
    if (!allowedHosts.has(hostOf(parsed.host))) throw new HttpError(403, "Cross-origin requests are not allowed.");
  }

  /** Last line of defence: no single job may hold the queue longer than this, whatever it is waiting on. */
  const JOB_HARD_LIMIT_MS = 120_000;

  function bounded(task: () => Promise<void>, onLimit: () => void): () => Promise<void> {
    return () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          onLimit();
          log("job exceeded the hard limit; restarting the browser");
          void closeBrowser(3_000).finally(resolve);
        }, JOB_HARD_LIMIT_MS);
        task().then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          () => {
            clearTimeout(timer);
            resolve();
          },
        );
      });
  }

  function enqueue(client: string, task: () => Promise<void>, onLimit: () => void = () => undefined): void {
    if (queued >= limits.queueMax) throw new HttpError(429, "UXAudit is busy right now. Try again in a minute.");
    queued += 1;
    clientPending.set(client, (clientPending.get(client) ?? 0) + 1);
    queue = queue
      .then(bounded(task, onLimit))
      .catch(() => undefined)
      .finally(() => {
        queued -= 1;
        const pending = (clientPending.get(client) ?? 1) - 1;
        if (pending <= 0) clientPending.delete(client);
        else clientPending.set(client, pending);
      });
  }

  /** Reviews are network-bound and follow an audit that already holds the client's slot, so they bypass the per-client pending guard. */
  function enqueueReview(client: string, task: () => Promise<void>): void {
    queue = queue.then(task).catch(() => undefined);
    void client;
  }

  function failureFor(err: unknown): { message: string; kind: string } {
    if (err instanceof AnalyzeError || err instanceof ReviewError) {
      log(`job failed (${err.kind}): ${scrubLog(err.message)}`);
      return { message: err.message, kind: err.kind };
    }
    log(`job failed: ${scrubLog(err instanceof Error ? err.message : String(err))}`);
    return { message: "Something went wrong while analyzing that page.", kind: "failed" };
  }

  function runAudit(job: JobState, client: string): void {
    jobClients.set(job, client);
    const onLimit = () => {
      if (job.status === "running" || job.status === "queued") {
        job.status = "error";
        job.stage = "Failed";
        job.error = { message: "The page kept the browser busy for too long, so the analysis was stopped.", kind: "timeout" };
      }
    };
    enqueue(
      client,
      async () => {
      if (closing) {
        job.status = "error";
        job.stage = "Failed";
        job.error = { message: "The server is shutting down.", kind: "failed" };
        return;
      }
      job.status = "running";
      job.stage = "Checking the address";
      try {
        const { result, screenshots } = await analyzeUrl(job.url, {
          proxyUrl: proxy.url,
          proxyReason: proxy.reasonFor,
          allowPrivateHosts: opts.allowPrivateHosts,
          lookup: opts.lookup,
          chromiumSandbox: opts.chromiumSandbox,
          onStage: (stage) => {
            job.stage = stage;
          },
        });
        await store.save(job.id, result, screenshots);
        job.status = "done";
        job.stage = "Done";
        job.result = result;
        log(`audited ${scrubLog(new URL(result.finalUrl).host)}: ${result.checks.filter((c) => c.status === "fail").length} problems`);
        // The AI review follows automatically; when it cannot run, the job says why.
        await startReview(job, client);
      } catch (err) {
        job.status = "error";
        job.stage = "Failed";
        job.error = failureFor(err);
      } finally {
        setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000).unref();
      }
      },
      onLimit,
    );
  }

  async function reviewBudgetUsed(): Promise<boolean> {
    const counter = await store.readCounter("reviews");
    return counter.day === today() && counter.count >= limits.reviewsPerDay;
  }

  async function consumeReviewBudget(): Promise<void> {
    const counter = await store.readCounter("reviews");
    const day = today();
    await store.writeCounter("reviews", { day, count: counter.day === day ? counter.count + 1 : 1 });
  }

  /** Queues the AI review for a finished audit, or records on the job why it will not run. */
  async function startReview(job: JobState, client: string): Promise<void> {
    if (!reviewEnabled) {
      job.review = { status: "error", error: { message: "AI review is not configured on this server.", kind: "config" } };
      return;
    }
    if (clientReviews.get(client) >= limits.reviewsPerClientPerDay) {
      job.review = { status: "error", error: { message: `You have used today's ${limits.reviewsPerClientPerDay} AI reviews. The checks above still ran.`, kind: "quota" } };
      return;
    }
    if (await reviewBudgetUsed()) {
      job.review = { status: "error", error: { message: "Today's free AI-review budget has been used up. It resets at midnight Pacific time.", kind: "quota" } };
      return;
    }
    clientReviews.increment(client);
    runReview(job, client);
  }

  function runReview(job: JobState, client: string): void {
    const state: ReviewState = { status: "queued" };
    job.review = state;
    enqueueReview(client, async () => {
      state.status = "running";
      try {
        if (closing) throw new ReviewError("The server is shutting down.", "unavailable");
        if (!opts.geminiApiKey || !instruction) throw new ReviewError("AI review is not configured on this server.", "config");
        if (await reviewBudgetUsed()) throw new ReviewError("Today's free AI-review budget has been used up. It resets at midnight Pacific time.", "quota");
        const result = job.result ?? (await store.get(job.id));
        if (!result) throw new ReviewError("The audit is no longer available.", "unavailable");
        const loadFrames = async (prefix: "desktop" | "mobile", count: number) =>
          (await Promise.all(Array.from({ length: count }, (_, i) => store.image(job.id, `${prefix}-frame-${i + 1}`)))).filter((b): b is Buffer => !!b);
        const desktopFrames = await loadFrames("desktop", result.coverage?.desktopFrames ?? 0);
        const mobileFrames = await loadFrames("mobile", result.coverage?.mobileFrames ?? 0);
        if (!desktopFrames.length) throw new ReviewError("The audit's screenshots are no longer available.", "unavailable");
        await consumeReviewBudget();
        const review = await requestReview(result, { desktopFrames, mobileFrames }, {
          apiKey: opts.geminiApiKey,
          model: opts.geminiModel,
          instruction,
          fetchImpl: opts.reviewFetch,
        });
        await store.saveReview(job.id, review);
        state.status = "done";
        state.result = review;
        log(`reviewed ${job.id}: score ${review.overallScore ?? "null"} in ${review.durationMs}ms`);
      } catch (err) {
        state.status = "error";
        state.error = failureFor(err);
      }
    });
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const client = clientOf(req);
    const [head, id, sub, name] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

    if (head === "audits" && !id && method === "POST") {
      const body = await readJson(req);
      const input = typeof body.url === "string" ? body.url.trim() : "";
      try {
        parseTargetUrl(input, { allowPrivate: (opts.allowPrivateHosts?.length ?? 0) > 0 });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      if (clientPending.get(client)) throw new HttpError(429, "You already have an analysis in progress. Wait for it to finish.");
      if (clientAudits.get(client) >= limits.auditsPerClientPerDay) throw new HttpError(429, `You have used today's ${limits.auditsPerClientPerDay} analyses. Try again tomorrow.`);
      const job: JobState = { id: store.newId(), status: "queued", stage: "Waiting", url: input, startedAt: new Date().toISOString() };
      runAudit(job, client);
      clientAudits.increment(client);
      jobs.set(job.id, job);
      return send(res, 202, { id: job.id, status: job.status });
    }

    if (head === "audits" && id && !sub && method === "GET") {
      const job = jobs.get(id);
      if (job) return send(res, 200, job);
      const stored = await store.get(id);
      if (!stored) throw new HttpError(404, "Audit not found.");
      const review = await store.getReview(id);
      const state: JobState = { id, status: "done", stage: "Done", url: stored.requestedUrl, startedAt: stored.capturedAt, result: stored };
      if (review) state.review = { status: "done", result: review };
      return send(res, 200, state);
    }

    if (head === "audits" && id && !sub && method === "DELETE") {
      jobs.delete(id);
      if (!(await store.remove(id))) throw new HttpError(404, "Audit not found.");
      return send(res, 200, { ok: true });
    }

    if (head === "audits" && id && sub === "review" && method === "POST") {
      if (!reviewEnabled) throw new HttpError(503, "AI review is not configured on this server.");
      let job = jobs.get(id);
      if (!job) {
        const stored = await store.get(id);
        if (!stored) throw new HttpError(404, "Audit not found.");
        job = { id, status: "done", stage: "Done", url: stored.requestedUrl, startedAt: stored.capturedAt, result: stored };
        jobs.set(id, job);
        setTimeout(() => jobs.delete(id), 10 * 60 * 1000).unref();
      }
      // Reviews start automatically after an audit; this route only retries one that failed.
      if (job.status !== "done") throw new HttpError(409, "The analysis has not finished yet.");
      if (job.review?.status === "done" || (await store.getReview(id))) throw new HttpError(409, "This audit already has a review.");
      if (job.review && job.review.status !== "error") return send(res, 200, { id, review: job.review.status });
      if (clientReviews.get(client) >= limits.reviewsPerClientPerDay) throw new HttpError(429, `You have used today's ${limits.reviewsPerClientPerDay} AI reviews. Try again tomorrow.`);
      if (await reviewBudgetUsed()) throw new HttpError(429, "Today's free AI-review budget has been used up. It resets at midnight Pacific time.");
      clientReviews.increment(client);
      runReview(job, client);
      return send(res, 202, { id, review: "queued" });
    }

    if (head === "audits" && id && sub === "images" && name && method === "GET") {
      const image = await store.image(id, name);
      if (!image) throw new HttpError(404, "Image not found.");
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/jpeg", "cache-control": "private, max-age=3600" });
      res.end(image);
      return;
    }

    throw new HttpError(404, "Not found.");
  }

  async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
    const rel = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) throw new HttpError(403, "Forbidden");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, "Not found");
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(await readFile(file));
  }

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(res, 400, { error: "Malformed request URL." });
    }
    const handler = (async () => {
      requireHostAndOrigin(req);
      if (url.pathname.startsWith("/api")) await api(req, res, url);
      else await serveStatic(url.pathname, res);
    })();
    handler.catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      log(`request failed: ${scrubLog(err instanceof Error ? err.message : String(err))}`);
      send(res, 500, { error: "Something went wrong on the server." });
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 50;

  const host = opts.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 3131, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  const sweep = async () => {
    const removed = await store.sweep(limits.retentionHours * 3_600_000, limits.maxStoredAudits).catch(() => 0);
    if (removed) log(`removed ${removed} expired audits`);
  };
  await sweep();
  const sweeper = setInterval(sweep, 10 * 60 * 1000);
  sweeper.unref();

  return {
    url: `http://${host}:${port}/`,
    port,
    store,
    jobs,
    limits,
    reviewEnabled,
    instructionSource: loaded?.source ?? null,
    async close() {
      closing = true;
      clearInterval(sweeper);
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Let in-flight work finish (queued work exits immediately) before the browser goes away,
      // otherwise a late job would relaunch Chromium after shutdown.
      await queue.catch(() => undefined);
      await closeBrowser();
      await proxy.close();
    },
  };
}
