import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDataBlock, loadInstruction, requestReview, ReviewError, validateReview } from "../src/review.ts";
import type { AuditResult } from "../src/analyze.ts";

const audit: AuditResult = {
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  title: 'Example <script>alert(1)</script> "quoted"',
  httpStatus: 200,
  capturedAt: "2026-10-25T20:00:00.000Z",
  viewports: { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } },
  fullPageHeight: 1200,
  coverage: { desktopFrames: 2, desktopHeight: 1200, desktopCovered: 1200, mobileFrames: 1, mobileHeight: 800, mobileCovered: 800 },
  checks: [
    { id: "h1", title: "Main heading", status: "fail", severity: "medium", summary: "The page has no h1 heading.", examples: [], meaning: "m", fix: "f" },
  ],
  facts: {
    page: { title: "", lang: null, hasViewportMeta: true, h1Count: 0, headingLevels: [], imagesTotal: 0, imagesWithoutAlt: [], controlsTotal: 0, controlsWithoutName: [], fieldsTotal: 0, fieldsWithoutLabel: [], genericLinks: [], textLength: 0 },
    mobile: { scrollWidth: 390, viewportWidth: 390, tapTargetsTotal: 0, smallTapTargets: [] },
  },
  notes: [],
};

const good = {
  overall_score: 7,
  score_reason: "Clear hierarchy, cramped footer.",
  strengths: [{ title: "Bold headline", location: "Hero", evidence: "Largest text on the page", why_it_works: "Guides attention first." }],
  weaknesses: [{ title: "Tiny footer links", priority: "medium", location: "Footer", evidence: "12px grey text", why_it_matters: "Hard to read.", why_it_works: null }],
  limitations: ["Hover states not visible."],
};
const meta = { model: "test-model", durationMs: 1234, tokens: 100 };

describe("review data block", () => {
  it("quotes page text as untrusted data with caps", () => {
    const block = buildDataBlock(audit);
    assert.ok(block.startsWith("BEGIN UNTRUSTED PAGE DATA"));
    assert.ok(block.includes(JSON.stringify(audit.title)));
    assert.ok(block.includes("Main heading: FAIL"));
    assert.ok(block.endsWith("END UNTRUSTED PAGE DATA."));
  });
});

describe("validateReview", () => {
  it("accepts the expected shape and normalizes fields", () => {
    const review = validateReview(JSON.stringify(good), meta);
    assert.equal(review.overallScore, 7);
    assert.equal(review.strengths[0]?.explanation, "Guides attention first.");
    assert.equal(review.weaknesses[0]?.priority, "Medium");
    assert.equal(review.weaknesses[0]?.explanation, "Hard to read.");
    assert.equal(review.model, "test-model");
  });

  it("allows a null score and rejects invalid scores, non-JSON and empty reviews", () => {
    assert.equal(validateReview(JSON.stringify({ ...good, overall_score: null }), meta).overallScore, null);
    for (const bad of [{ ...good, overall_score: 11 }, { ...good, overall_score: "7" }, { ...good, overall_score: 2.5 }]) {
      assert.throws(() => validateReview(JSON.stringify(bad), meta), ReviewError);
    }
    assert.throws(() => validateReview("not json", meta), (e: unknown) => e instanceof ReviewError && e.kind === "invalid");
    assert.throws(() => validateReview("[]", meta), ReviewError);
    assert.throws(() => validateReview(JSON.stringify({ overall_score: 5 }), meta), ReviewError);
  });

  it("caps lengths and item counts and drops malformed items", () => {
    const long = "x".repeat(5000);
    const review = validateReview(
      JSON.stringify({
        overall_score: 3,
        score_reason: long,
        strengths: Array.from({ length: 20 }, () => ({ title: "t", evidence: long, why_it_works: long })),
        weaknesses: [{ title: "", evidence: "e" }, 42, { title: "ok", evidence: "e", priority: "URGENT" }],
        limitations: Array.from({ length: 10 }, () => long),
      }),
      meta,
    );
    assert.ok(review.scoreReason.length <= 701);
    assert.equal(review.strengths.length, 8);
    assert.ok(review.strengths[0]!.evidence.length <= 701);
    assert.equal(review.weaknesses.length, 1);
    assert.equal(review.weaknesses[0]!.priority, "Medium");
    assert.equal(review.limitations.length, 6);
  });
});

describe("requestReview", () => {
  const images = { desktopFrames: [Buffer.from("d1"), Buffer.from("d2")], mobileFrames: [Buffer.from("m1")] };
  const responseWith = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const okBody = { candidates: [{ content: { parts: [{ text: JSON.stringify(good) }] } }], usageMetadata: { totalTokenCount: 321 } };

  it("sends the key only in a header, every frame, the instruction, and retries on 503", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let n = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      n += 1;
      return n === 1 ? responseWith(503, { error: "busy" }) : responseWith(200, okBody);
    }) as unknown as typeof fetch;
    const review = await requestReview(audit, images, { apiKey: "SECRET", instruction: "Be a critic.", fetchImpl, waitMs: () => 1 });
    assert.equal(calls.length, 2);
    assert.equal((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"], "SECRET");
    assert.ok(!calls[0]!.url.includes("SECRET"));
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.system_instruction.parts[0].text, "Be a critic.");
    assert.equal(body.contents[0].parts.filter((p: { inline_data?: unknown }) => p.inline_data).length, 3);
    assert.ok(String(body.contents[0].parts[0].text).includes("Desktop frame 1 of 2"));
    assert.ok(String(body.contents[0].parts.at(-1).text).includes("UNTRUSTED"));
    assert.equal(review.tokens, 321);
    assert.equal(review.overallScore, 7);
  });

  it("maps quota, credential and persistent outage responses to clear errors", async () => {
    const make = (status: number) => (async () => responseWith(status, { error: "x" })) as unknown as typeof fetch;
    const base = { apiKey: "k", instruction: "i", waitMs: () => 1 };
    await assert.rejects(requestReview(audit, images, { ...base, fetchImpl: make(429) }), (e: unknown) => e instanceof ReviewError && e.kind === "quota");
    await assert.rejects(requestReview(audit, images, { ...base, fetchImpl: make(403) }), (e: unknown) => e instanceof ReviewError && e.kind === "config");
    await assert.rejects(requestReview(audit, images, { ...base, fetchImpl: make(503), maxAttempts: 2 }), (e: unknown) => e instanceof ReviewError && e.kind === "unavailable");
    const garbage = (async () => responseWith(200, { candidates: [{ content: { parts: [{ text: "not json" }] } }] })) as unknown as typeof fetch;
    await assert.rejects(requestReview(audit, images, { ...base, fetchImpl: garbage }), (e: unknown) => e instanceof ReviewError && e.kind === "invalid");
  });
});

describe("loadInstruction", () => {
  it("prefers the environment variable, then a named file, and reports where it came from", async () => {
    const fromEnv = await loadInstruction({ REVIEW_INSTRUCTION: "  Be exact.  " });
    assert.deepEqual(fromEnv, { text: "Be exact.", source: "REVIEW_INSTRUCTION" });
    const fromB64 = await loadInstruction({ REVIEW_INSTRUCTION_B64: Buffer.from("Be brief.").toString("base64") });
    assert.deepEqual(fromB64, { text: "Be brief.", source: "REVIEW_INSTRUCTION_B64" });
    const missing = await loadInstruction({ REVIEW_INSTRUCTION_FILE: "/nonexistent/instruction.txt" });
    assert.ok(missing === null || missing.source === "prompts/review-instruction.txt");
  });
});
