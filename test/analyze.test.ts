import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeUrl, AnalyzeError, closeBrowser } from "../src/analyze.ts";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.ts";
import { closedPort, startFixtureServer } from "./helpers.ts";

describe("analyzeUrl through the egress proxy", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let proxy: EgressProxy;
  let base: string;
  const lookup = async (host: string) => {
    if (host === "fixture.test") return ["127.0.0.1"];
    throw new Error("ENOTFOUND");
  };
  const common = () => ({ proxyUrl: proxy.url, proxyReason: proxy.reasonFor, lookup, allowPrivateHosts: ["fixture.test", "127.0.0.1"] });

  before(async () => {
    fixture = await startFixtureServer();
    proxy = await startEgressProxy({ lookup, allowPrivateHosts: ["fixture.test", "127.0.0.1"] });
    base = `http://fixture.test:${new URL(fixture.url).port}/`;
  });
  after(async () => {
    await closeBrowser();
    await proxy.close();
    await fixture.close();
  });

  it("captures both viewports and reports the planted problems", async () => {
    const stages: string[] = [];
    const { result, screenshots } = await analyzeUrl(base, { ...common(), onStage: (s) => stages.push(s) });
    assert.equal(result.title, "Harbor Ferry Schedule");
    assert.equal(result.httpStatus, 200);
    assert.ok(stages.length >= 4);
    assert.ok(screenshots.desktopFrames.length >= 1 && screenshots.mobileFrames.length >= 1, "frames captured");
    assert.equal(result.coverage.desktopFrames, screenshots.desktopFrames.length);
    assert.ok(result.coverage.desktopCovered <= result.coverage.desktopHeight);
    for (const jpg of [screenshots.desktop, screenshots.desktopFull, screenshots.mobile, screenshots.mobileFull, ...screenshots.desktopFrames, ...screenshots.mobileFrames]) {
      assert.equal(jpg[0], 0xff, "JPEG magic");
      assert.equal(jpg[1], 0xd8);
    }
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    assert.equal(byId.title!.status, "pass");
    assert.equal(byId.lang!.status, "warn");
    assert.equal(byId.viewport!.status, "fail");
    assert.equal(byId.h1!.status, "fail");
    assert.equal(byId["heading-order"]!.status, "warn");
    assert.equal(byId["img-alt"]!.status, "fail");
    assert.equal(result.facts.page.imagesWithoutAlt.length, 2);
    assert.equal(byId["control-names"]!.status, "fail");
    assert.equal(result.facts.page.controlsWithoutName.length, 2);
    assert.equal(byId["form-labels"]!.status, "fail");
    assert.equal(byId["generic-links"]!.status, "warn");
    assert.equal(byId["mobile-overflow"]!.status, "fail");
    assert.ok(result.facts.mobile.scrollWidth >= 1400);
    assert.equal(byId["tap-targets"]!.status, "warn");
  });

  it("stops a redirect into a private network even though the first hop was public", async () => {
    await assert.rejects(
      analyzeUrl(base + "redirect-private", { ...common(), navigationTimeoutMs: 10_000 }),
      (err: unknown) => err instanceof AnalyzeError && err.kind === "blocked",
    );
    assert.ok(proxy.stats().refused >= 1, "the proxy refused the metadata address");
  });

  it("refuses private addresses and non-web schemes before launching anything", async () => {
    for (const bad of ["http://127.0.0.1:9/", "http://169.254.169.254/", "file:///etc/hosts", "http://localhost:3000/"]) {
      await assert.rejects(analyzeUrl(bad, { proxyUrl: proxy.url, lookup }), (err: unknown) => err instanceof AnalyzeError && err.kind === "blocked", bad);
    }
    await assert.rejects(analyzeUrl("https://nowhere.example/", { proxyUrl: proxy.url, lookup }), (err: unknown) => err instanceof AnalyzeError && err.kind === "unreachable");
  });

  it("reports a refused connection as unreachable", async () => {
    await assert.rejects(
      analyzeUrl(`http://127.0.0.1:${await closedPort()}/`, { ...common(), navigationTimeoutMs: 5_000 }),
      (err: unknown) => err instanceof AnalyzeError && err.kind === "unreachable",
    );
  });

  it("times out on a slow page and on a page that pins the main thread after load", async () => {
    await assert.rejects(
      analyzeUrl(base + "slow", { ...common(), navigationTimeoutMs: 1_000 }),
      (err: unknown) => err instanceof AnalyzeError && err.kind === "timeout",
    );
    const t0 = Date.now();
    await assert.rejects(
      analyzeUrl(base + "hang", { ...common(), navigationTimeoutMs: 10_000, deadlineMs: 6_000 }),
      (err: unknown) => err instanceof AnalyzeError && err.kind === "timeout",
    );
    assert.ok(Date.now() - t0 < 15_000, "the deadline tore the page down");
  });

  it("caps and sanitizes page-controlled strings", async () => {
    const { result } = await analyzeUrl(base + "hostile", common());
    assert.ok(result.title.length <= 302, `title clipped (${result.title.length})`);
    assert.ok((result.facts.page.lang ?? "").length <= 37);
    for (const example of result.facts.page.imagesWithoutAlt) assert.ok(example.length <= 122);
    assert.ok(result.checks.every((c) => c.summary.length < 600));
  });
});
