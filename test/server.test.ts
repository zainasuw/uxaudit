import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { startServer } from "../src/server.ts";
import type { JobState } from "../src/server.ts";
import { closedPort, startFixtureServer, TMP } from "./helpers.ts";

describe("UXAudit server", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let server: Awaited<ReturnType<typeof startServer>>;
  let tmp: string;
  let auditId: string;

  const api = (p: string, init?: RequestInit) =>
    fetch(server.url.replace(/\/$/, "") + p, { headers: { "content-type": "application/json" }, ...init });

  before(async () => {
    await mkdir(TMP, { recursive: true });
    tmp = await mkdtemp(path.join(TMP, "server-"));
    fixture = await startFixtureServer();
    server = await startServer({ port: 0, storeDir: tmp, allowPrivate: true });
  });
  after(async () => {
    await server.close();
    await fixture.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("serves the app", async () => {
    const res = await fetch(server.url);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("UXAudit"));
    assert.equal((await fetch(server.url + "styles.css")).status, 200);
    assert.equal((await fetch(server.url + "../package.json")).status, 404);
  });

  it("rejects bad addresses immediately with a readable message", async () => {
    // Private-host refusal is covered by url-guard.test.ts; this server allows loopback for the fixture.
    for (const [url, pattern] of [
      ["", /Paste a website address/],
      ["file:///etc/passwd", /Only http and https/],
      ["https://user:pw@example.com", /credentials/],
    ] as const) {
      const res = await api("/api/audits", { method: "POST", body: JSON.stringify({ url }) });
      assert.equal(res.status, 400, url);
      assert.match(((await res.json()) as { error: string }).error, pattern);
    }
    const notJson = await fetch(server.url + "api/audits", { method: "POST", body: "url=x" });
    assert.equal(notJson.status, 415);
    const evil = await fetch(server.url + "api/audits", { headers: { origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
  });

  it("runs an audit through the job API and stores it", async () => {
    const started = await api("/api/audits", { method: "POST", body: JSON.stringify({ url: fixture.url }) });
    assert.equal(started.status, 202);
    const { id } = (await started.json()) as { id: string };
    auditId = id;
    let job: JobState | null = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      job = (await (await api(`/api/audits/${id}`)).json()) as JobState;
      if (job.status === "done" || job.status === "error") break;
    }
    assert.equal(job?.status, "done", JSON.stringify(job?.error));
    assert.equal(job?.result?.title, "Harbor Ferry Schedule");
    assert.ok(job!.result!.checks.some((c) => c.id === "mobile-overflow" && c.status === "fail"));

    for (const name of ["desktop", "mobile", "desktop-full"]) {
      const img = await fetch(server.url + `api/audits/${id}/images/${name}`);
      assert.equal(img.status, 200, name);
      assert.equal(img.headers.get("content-type"), "image/png");
    }
    assert.equal((await fetch(server.url + `api/audits/${id}/images/..%2Faudit`)).status, 404);

    const list = (await (await api("/api/audits")).json()) as Array<{ id: string; failed: number }>;
    assert.equal(list[0]?.id, id);
    assert.ok(list[0]!.failed >= 4);
  });

  it("reports an unreachable site as a job error, not a crash", async () => {
    const started = await api("/api/audits", { method: "POST", body: JSON.stringify({ url: `http://127.0.0.1:${await closedPort()}/` }) });
    const { id } = (await started.json()) as { id: string };
    let job: JobState | null = null;
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      job = (await (await api(`/api/audits/${id}`)).json()) as JobState;
      if (job.status === "done" || job.status === "error") break;
    }
    assert.equal(job?.status, "error");
    assert.equal(job?.error?.kind, "unreachable");
    assert.equal((await api("/api/state")).status, 404, "server still answering");
  });

  it("deletes audits", async () => {
    assert.equal((await api(`/api/audits/${auditId}`, { method: "DELETE" })).status, 200);
    assert.equal((await api(`/api/audits/${auditId}`)).status, 404);
    assert.equal((await api(`/api/audits/nope`, { method: "DELETE" })).status, 404);
  });
});
