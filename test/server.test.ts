import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { startServer } from "../src/server.ts";
import type { JobState } from "../src/server.ts";
import { closedPort, startFixtureServer, TMP } from "./helpers.ts";

const goodReview = {
  overall_score: 6,
  score_reason: "Mixed.",
  strengths: [{ title: "Clear title", location: "Header", evidence: "Large text", why_it_works: "Orients visitors." }],
  weaknesses: [{ title: "Overflowing banner", priority: "High", location: "Top", evidence: "Wider than the phone", why_it_matters: "Content is cut off." }],
  limitations: ["Static screenshots only."],
};

describe("UXAudit server", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let server: Awaited<ReturnType<typeof startServer>>;
  let tmp: string;
  let base: string;
  let auditId: string;
  let reviewCalls = 0;
  let reviewStatus = 200;

  const lookup = async (host: string) => {
    if (host === "fixture.test") return ["127.0.0.1"];
    throw new Error("ENOTFOUND");
  };
  const reviewFetch = (async () => {
    reviewCalls += 1;
    const body = reviewStatus === 200 ? { candidates: [{ content: { parts: [{ text: JSON.stringify(goodReview) }] } }], usageMetadata: { totalTokenCount: 10 } } : { error: "x" };
    return new Response(JSON.stringify(body), { status: reviewStatus, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const api = (p: string, init?: RequestInit) =>
    fetch(server.url.replace(/\/$/, "") + p, { headers: { "content-type": "application/json" }, ...init });
  const waitFor = async (id: string, pending: (j: JobState) => boolean): Promise<JobState> => {
    let job: JobState | null = null;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 250));
      job = (await (await api(`/api/audits/${id}`)).json()) as JobState;
      if (!pending(job)) break;
    }
    return job!;
  };

  before(async () => {
    await mkdir(TMP, { recursive: true });
    tmp = await mkdtemp(path.join(TMP, "server-"));
    fixture = await startFixtureServer();
    base = `http://fixture.test:${new URL(fixture.url).port}/`;
    server = await startServer({
      port: 0,
      storeDir: tmp,
      allowPrivateHosts: ["fixture.test", "127.0.0.1"],
      lookup,
      geminiApiKey: "test-key",
      reviewFetch,
      limits: { reviewsPerClientPerDay: 2, reviewsPerDay: 2, queueMax: 3 },
    });
  });
  after(async () => {
    await server.close();
    await fixture.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("serves the app with security headers", async () => {
    const res = await fetch(server.url);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("UXAudit"));
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'self' https:\/\/huggingface\.co/);
    assert.equal((await fetch(server.url + "../package.json")).status, 404);
    assert.equal((await fetch(server.url + ".env")).status, 404);
  });

  it("rejects bad input, wrong hosts, foreign origins and non-JSON bodies", async () => {
    for (const [url, pattern] of [
      ["", /Paste a website address/],
      ["file:///etc/passwd", /Only http and https/],
      ["https://user:pw@example.com", /credentials/],
    ] as const) {
      const res = await api("/api/audits", { method: "POST", body: JSON.stringify({ url }) });
      assert.equal(res.status, 400, url);
      assert.match(((await res.json()) as { error: string }).error, pattern);
    }
    assert.equal((await fetch(server.url + "api/audits", { method: "POST", body: "url=x" })).status, 415);
    assert.equal((await fetch(server.url + "api/audits", { headers: { origin: "https://evil.example" } })).status, 403);
    // fetch() refuses to send a custom Host header, so use the raw client for the DNS-rebinding check.
    const wrongHost = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port: server.port, path: "/", headers: { host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
    assert.equal(wrongHost, 403);
    assert.equal((await api("/api/audits")).status, 404, "no global listing of audits");
  });

  it("runs an audit through the job API, stores it, and serves JPEG images", async () => {
    const started = await api("/api/audits", { method: "POST", body: JSON.stringify({ url: base }) });
    assert.equal(started.status, 202);
    const { id } = (await started.json()) as { id: string };
    assert.match(id, /^[a-f0-9]{24}$/, "unguessable id");
    auditId = id;
    const job = await waitFor(id, (j) => j.status === "queued" || j.status === "running");
    assert.equal(job.status, "done", JSON.stringify(job.error));
    assert.equal(job.result?.title, "Harbor Ferry Schedule");
    for (const name of ["desktop", "mobile", "desktop-full", "mobile-full", "desktop-frame-1", "mobile-frame-1"]) {
      const img = await fetch(server.url + `api/audits/${id}/images/${name}`);
      assert.equal(img.status, 200, name);
      assert.equal(img.headers.get("content-type"), "image/jpeg");
    }
    assert.equal((await fetch(server.url + `api/audits/${id}/images/..%2Faudit`)).status, 404);
  });

  it("runs the AI review automatically after an audit, stores it, and refuses a duplicate", async () => {
    const job = await waitFor(auditId, (j) => !j.review || j.review.status === "queued" || j.review.status === "running");
    assert.equal(job.review?.status, "done", JSON.stringify(job.review?.error));
    assert.equal(job.review?.result?.overallScore, 6);
    assert.equal(job.review?.result?.weaknesses[0]?.priority, "High");
    assert.equal(reviewCalls, 1);
    assert.equal((await api(`/api/audits/${auditId}/review`, { method: "POST" })).status, 409);
    const stored = (await (await api(`/api/audits/${auditId}`)).json()) as JobState;
    assert.equal(stored.review?.result?.scoreReason, "Mixed.");
  });

  it("reports provider failures honestly, allows a retry, and enforces the daily review budget", async () => {
    reviewStatus = 503;
    const second = (await (await api("/api/audits", { method: "POST", body: JSON.stringify({ url: base + "hostile" }) })).json()) as { id: string };
    const failed = await waitFor(second.id, (j) => j.status !== "done" || !j.review || j.review.status === "queued" || j.review.status === "running");
    assert.equal(failed.review?.status, "error");
    assert.equal(failed.review?.error?.kind, "unavailable");
    reviewStatus = 200;
    // Both reviews so far counted against the budget of 2, so the next audit's automatic review is declined up front.
    const third = (await (await api("/api/audits", { method: "POST", body: JSON.stringify({ url: base }) })).json()) as { id: string };
    const declined = await waitFor(third.id, (j) => j.status !== "done" || !j.review || j.review.status === "queued" || j.review.status === "running");
    assert.equal(declined.status, "done", "the checks still ran");
    assert.equal(declined.review?.status, "error");
    assert.equal(declined.review?.error?.kind, "quota");
    const retry = await api(`/api/audits/${third.id}/review`, { method: "POST" });
    assert.equal(retry.status, 429);
    assert.match(((await retry.json()) as { error: string }).error, /used/i);
  });

  it("reports an unreachable site as a job error, not a crash", async () => {
    const started = await api("/api/audits", { method: "POST", body: JSON.stringify({ url: `http://127.0.0.1:${await closedPort()}/` }) });
    const { id } = (await started.json()) as { id: string };
    const job = await waitFor(id, (j) => j.status === "queued" || j.status === "running");
    assert.equal(job.status, "error");
    assert.equal(job.error?.kind, "unreachable");
  });

  it("refuses a second concurrent analysis from the same client", async () => {
    const first = await api("/api/audits", { method: "POST", body: JSON.stringify({ url: base + "slow" }) });
    assert.equal(first.status, 202);
    const second = await api("/api/audits", { method: "POST", body: JSON.stringify({ url: base }) });
    assert.equal(second.status, 429);
    const { id } = (await first.json()) as { id: string };
    await waitFor(id, (j) => j.status === "queued" || j.status === "running");
  });

  it("deletes audits", async () => {
    assert.equal((await api(`/api/audits/${auditId}`, { method: "DELETE" })).status, 200);
    assert.equal((await api(`/api/audits/${auditId}`)).status, 404);
    assert.equal((await api(`/api/audits/000000000000000000000000`, { method: "DELETE" })).status, 404);
  });

  it("does not let a client choose its own address through X-Forwarded-For", async () => {
    // This test server does not trust a proxy, so the header is ignored entirely; the
    // limiter sees one client and refuses the second concurrent analysis.
    const first = await api("/api/audits", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "1.1.1.1" }, body: JSON.stringify({ url: base + "slow" }) });
    assert.equal(first.status, 202);
    const second = await api("/api/audits", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "2.2.2.2" }, body: JSON.stringify({ url: base }) });
    assert.equal(second.status, 429);
    const { id } = (await first.json()) as { id: string };
    await waitFor(id, (j) => j.status === "queued" || j.status === "running" || (!!j.review && (j.review.status === "queued" || j.review.status === "running")));
  });
});
