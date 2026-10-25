import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeUrl, AnalyzeError, closeBrowser } from "../src/analyze.ts";
import { closedPort, startFixtureServer } from "./helpers.ts";

describe("analyzeUrl on the fixture page", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;

  before(async () => {
    fixture = await startFixtureServer();
  });
  after(async () => {
    await closeBrowser();
    await fixture.close();
  });

  it("captures both viewports and reports the planted problems", async () => {
    const stages: string[] = [];
    const { result, screenshots } = await analyzeUrl(fixture.url, { allowPrivate: true, onStage: (s) => stages.push(s) });
    assert.equal(result.title, "Harbor Ferry Schedule");
    assert.equal(result.httpStatus, 200);
    assert.ok(stages.length >= 4);
    for (const png of [screenshots.desktop, screenshots.desktopFull, screenshots.mobile]) {
      assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
    }
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    assert.equal(byId.title!.status, "pass");
    assert.equal(byId.lang!.status, "warn", "no lang attribute");
    assert.equal(byId.viewport!.status, "fail", "no viewport meta");
    assert.equal(byId.h1!.status, "fail", "no h1");
    assert.equal(byId["heading-order"]!.status, "warn", "h2 → h4 skip");
    assert.match(byId["heading-order"]!.summary, /h2 → h4/);
    assert.equal(byId["img-alt"]!.status, "fail");
    assert.equal(result.facts.page.imagesWithoutAlt.length, 2, "logo link image and one ferry image lack alt");
    assert.equal(byId["control-names"]!.status, "fail");
    assert.equal(result.facts.page.controlsWithoutName.length, 2, "the logo link and the unlabeled icon button");
    assert.ok(byId["control-names"]!.examples.some((e) => e.includes("<button")));
    assert.equal(byId["form-labels"]!.status, "fail");
    assert.equal(result.facts.page.fieldsWithoutLabel.length, 1, "the placeholder-only email field");
    assert.equal(byId["generic-links"]!.status, "warn");
    assert.ok(byId["generic-links"]!.examples[0]?.includes("Click here"));
    assert.equal(byId["mobile-overflow"]!.status, "fail", "1400px banner overflows the phone");
    assert.ok(result.facts.mobile.scrollWidth >= 1400);
    assert.equal(byId["tap-targets"]!.status, "warn");
    assert.ok(byId["tap-targets"]!.examples.some((e) => e.includes("16×16")));
    for (const check of result.checks) {
      assert.ok(check.meaning.length > 20 && check.fix.length > 20, `${check.id} explains itself`);
    }
  });

  it("refuses private addresses, redirects into private networks, and unreachable hosts", async () => {
    await assert.rejects(analyzeUrl("http://127.0.0.1:9/"), (err: unknown) => err instanceof AnalyzeError && err.kind === "blocked");
    await assert.rejects(analyzeUrl("http://169.254.169.254/"), (err: unknown) => err instanceof AnalyzeError && err.kind === "blocked");
    await assert.rejects(analyzeUrl("file:///etc/hosts"), (err: unknown) => err instanceof AnalyzeError && err.kind === "blocked");

    // The fixture host is allowed for the test, but the redirect target is a metadata address and must be stopped.
    const lookup = async () => ["93.184.216.34"];
    await assert.rejects(
      analyzeUrl(fixture.url + "redirect-private", { lookup, allowPrivate: false }),
      (err: unknown) => err instanceof AnalyzeError && err.kind === "blocked",
    );

    await assert.rejects(
      analyzeUrl(`http://127.0.0.1:${await closedPort()}/`, { allowPrivate: true, navigationTimeoutMs: 5_000 }),
      (err: unknown) => err instanceof AnalyzeError && err.kind === "unreachable",
    );
  });

  it("times out instead of hanging on a slow page", async () => {
    await assert.rejects(
      analyzeUrl(fixture.url + "slow", { allowPrivate: true, navigationTimeoutMs: 1_000 }),
      (err: unknown) => err instanceof AnalyzeError && err.kind === "timeout",
    );
  });
});
