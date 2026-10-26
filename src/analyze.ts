import { execFile } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { collectMobileFacts, collectPageFacts, evaluateChecks, type CheckResult, type MobileFacts, type PageFacts } from "./checks.js";
import { createHostGuard, parseTargetUrl, type Lookup } from "./url-guard.js";

export interface Screenshots {
  desktop: Buffer;
  desktopFull: Buffer;
  mobile: Buffer;
  mobileFull: Buffer;
  /** Screen-sized slices of the page from the top, for the reviewer; detail survives where one tall image would be downscaled. */
  desktopFrames: Buffer[];
  mobileFrames: Buffer[];
}

export interface AuditResult {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  httpStatus: number | null;
  capturedAt: string;
  viewports: { desktop: { width: number; height: number }; mobile: { width: number; height: number } };
  fullPageHeight: number;
  /** How much of each page the frames cover, in CSS px from the top. */
  coverage: { desktopFrames: number; desktopHeight: number; desktopCovered: number; mobileFrames: number; mobileHeight: number; mobileCovered: number };
  checks: CheckResult[];
  facts: { page: PageFacts; mobile: MobileFacts };
  notes: string[];
}

export interface AnalyzeOptions {
  /** Address of the egress proxy every page request must go through. */
  proxyUrl: string;
  /** The proxy itself, when available, so connection failures can be explained precisely. */
  proxyReason?: (hostname: string) => "blocked" | "unreachable" | undefined;
  /** Tests only: hostnames allowed to resolve to loopback/private addresses. */
  allowPrivateHosts?: string[];
  lookup?: Lookup;
  onStage?: (stage: string) => void;
  navigationTimeoutMs?: number;
  /** Hard ceiling for the whole audit; the browser contexts are torn down when it passes. */
  deadlineMs?: number;
  chromiumSandbox?: boolean;
}

export class AnalyzeError extends Error {
  constructor(message: string, public kind: "blocked" | "unreachable" | "timeout" | "failed") {
    super(message);
    this.name = "AnalyzeError";
  }
}

export const DESKTOP = { width: 1280, height: 800 };
export const MOBILE = { width: 390, height: 844 };
const MAX_FULL_PAGE_HEIGHT = 10_000;
const MAX_DESKTOP_FRAMES = 10;
const MAX_MOBILE_FRAMES = 8;
const SETTLE_MS = 800;
const JPEG_QUALITY = 85;
const TITLE_MAX = 300;
const LANG_MAX = 35;
const URL_MAX = 2048;
const EXAMPLE_MAX = 120;
const EXAMPLES_MAX = 5;

let browserPromise: Promise<Browser> | null = null;
let browserProxy = "";

async function getBrowser(proxyUrl: string, sandbox: boolean): Promise<Browser> {
  if (browserPromise && browserProxy !== proxyUrl) {
    await closeBrowser();
  }
  if (!browserPromise) {
    browserProxy = proxyUrl;
    browserPromise = chromium
      .launch({
        headless: true,
        handleSIGINT: false,
        chromiumSandbox: sandbox,
        // "<-loopback>" forces even 127.0.0.1 through the proxy; Chromium would otherwise bypass it.
        proxy: { server: proxyUrl, bypass: "<-loopback>" },
        args: [
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--force-webrtc-ip-handling-policy",
          "--disable-features=WebRtcAllowInputVolumeAdjustment",
          "--disable-dev-shm-usage",
        ],
      })
      .then((b) => {
        b.on("disconnected", () => {
          browserPromise = null;
        });
        return b;
      });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

/** Closes the browser; if it does not cooperate within a few seconds, kills the process so the next audit starts clean. */
export async function closeBrowser(graceMs = 8_000): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  let browser: Browser;
  try {
    browser = await pending;
  } catch {
    return;
  }
  const closed = browser.close().then(() => true, () => true);
  const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs).unref());
  if (!(await Promise.race([closed, timedOut]))) {
    // Playwright does not expose the process; every Chromium we launch carries our
    // unique proxy address on its command line, so kill by that fingerprint.
    await new Promise<void>((resolve) => execFile("pkill", ["-9", "-f", `proxy-server=${browserProxy}`], () => resolve()));
  }
}

function describeNavigationError(err: unknown, url: string, reasonFor?: AnalyzeOptions["proxyReason"]): AnalyzeError {
  const message = err instanceof Error ? err.message : String(err);
  if (/Timeout/i.test(message)) return new AnalyzeError(`${url} did not finish loading within the time limit.`, "timeout");
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_CLOSED|ERR_PROXY_CONNECTION_FAILED|ERR_BLOCKED_BY_CLIENT|blockedbyclient/.test(message)) {
    // The proxy fails blocked and unreachable targets the same way; ask it which it was.
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = "";
    }
    if (reasonFor?.(hostname) === "unreachable") return new AnalyzeError(`${url} refused the connection or closed it.`, "unreachable");
    return new AnalyzeError(`${url} led to an address outside the public internet (a private, local or metadata address), so the analysis was stopped.`, "blocked");
  }
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return new AnalyzeError(`The address ${url} could not be found (DNS lookup failed).`, "unreachable");
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_TIMED_OUT|ERR_SOCKET_NOT_CONNECTED/.test(message)) {
    return new AnalyzeError(`${url} refused the connection or closed it.`, "unreachable");
  }
  if (/ERR_CERT|SSL/.test(message)) return new AnalyzeError(`${url} has an invalid HTTPS certificate.`, "unreachable");
  if (/ERR_ABORTED/.test(message)) return new AnalyzeError(`${url} started a download or aborted the navigation instead of showing a page.`, "failed");
  return new AnalyzeError(`Could not load ${url}: ${message.split("\n")[0]}`, "failed");
}


/** Scrolls through the page so lazy-loaded images and sections render before a full-page capture, then returns to the top. */
async function preloadBelowTheFold(page: Page, maxHeight: number): Promise<void> {
  await page
    .evaluate(async (limit) => {
      const step = Math.max(400, window.innerHeight);
      const total = Math.min(limit, Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
      for (let y = 0; y < total; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    }, maxHeight)
    .catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
}


/** Captures the page as consecutive screen-sized frames from the top (the page must already be fully loaded and scrolled through). */
async function captureFrames(page: Page, viewport: { width: number; height: number }, totalHeight: number, maxFrames: number): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  const limit = Math.min(totalHeight, viewport.height * maxFrames);
  for (let y = 0; y < limit && frames.length < maxFrames; y += viewport.height) {
    const height = Math.min(viewport.height, limit - y);
    if (height < 40) break;
    frames.push(await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, fullPage: true, clip: { x: 0, y, width: viewport.width, height } }));
  }
  return frames;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
  // When run through tsx, serialized functions reference a `__name` helper
  // that does not exist inside the page. A harmless shim keeps evaluation working.
  await page.evaluate("window.__name = window.__name || function (fn) { return fn; }").catch(() => undefined);
}

const clip = (s: unknown, n: number): string => {
  const text = typeof s === "string" ? s : "";
  return text.length > n ? text.slice(0, n) + "…" : text;
};
const clipList = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, EXAMPLES_MAX).map((x) => clip(x, EXAMPLE_MAX)) : []);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/** The page can forge anything it returns from evaluate; coerce every field to the shape and size we expect. */
function sanitizePageFacts(raw: unknown): PageFacts {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    title: clip(f.title, TITLE_MAX),
    lang: typeof f.lang === "string" ? clip(f.lang, LANG_MAX) : null,
    hasViewportMeta: f.hasViewportMeta === true,
    h1Count: num(f.h1Count),
    headingLevels: Array.isArray(f.headingLevels) ? f.headingLevels.slice(0, 500).map(num).filter((l) => l >= 1 && l <= 6) : [],
    imagesTotal: num(f.imagesTotal),
    imagesWithoutAlt: clipList(f.imagesWithoutAlt),
    controlsTotal: num(f.controlsTotal),
    controlsWithoutName: clipList(f.controlsWithoutName),
    fieldsTotal: num(f.fieldsTotal),
    fieldsWithoutLabel: clipList(f.fieldsWithoutLabel),
    genericLinks: clipList(f.genericLinks),
    textLength: num(f.textLength),
  };
}

function sanitizeMobileFacts(raw: unknown): MobileFacts {
  const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    scrollWidth: num(f.scrollWidth),
    viewportWidth: MOBILE.width,
    tapTargetsTotal: num(f.tapTargetsTotal),
    smallTapTargets: clipList(f.smallTapTargets),
  };
}

/**
 * Rejects after `ms` and tears the work down. The teardown is itself
 * time-boxed: a wedged page can make context.close() hang, and that must
 * never keep the deadline from firing or the queue from moving on.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, cleanup: () => Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AnalyzeError("The page kept the browser busy for too long, so the analysis was stopped.", "timeout"));
      void forceTeardown(cleanup);
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function forceTeardown(cleanup: () => Promise<void>): Promise<void> {
  const done = cleanup().then(() => true, () => true);
  const late = new Promise<false>((resolve) => setTimeout(() => resolve(false), 8_000).unref());
  if (!(await Promise.race([done, late]))) {
    await closeBrowser(3_000);
  }
}

export async function analyzeUrl(input: unknown, opts: AnalyzeOptions): Promise<{ result: AuditResult; screenshots: Screenshots }> {
  const stage = opts.onStage ?? (() => undefined);
  const allowPrivateHosts = new Set((opts.allowPrivateHosts ?? []).map((h) => h.toLowerCase()));
  let target: URL;
  try {
    target = parseTargetUrl(input, { allowPrivate: allowPrivateHosts.has("*") || allowPrivateHosts.has(String(input).toLowerCase()) || allowPrivateHosts.size > 0 });
  } catch (err) {
    throw new AnalyzeError(err instanceof Error ? err.message : String(err), "blocked");
  }
  if (!allowPrivateHosts.has("*") && !allowPrivateHosts.has(target.hostname.toLowerCase())) {
    const guard = createHostGuard(opts.lookup);
    const verdict = await guard.classify(target.hostname);
    if (verdict === "unresolvable") {
      throw new AnalyzeError(`The address ${target.hostname} could not be found (DNS lookup failed). Check the spelling.`, "unreachable");
    }
    if (verdict === "private") {
      throw new AnalyzeError("That address points to a private, local or reserved network, so it cannot be analyzed.", "blocked");
    }
  }

  const notes: string[] = [];
  const browser = await getBrowser(opts.proxyUrl, opts.chromiumSandbox ?? true);
  const navigationTimeout = opts.navigationTimeoutMs ?? 25_000;
  const contexts: BrowserContext[] = [];
  const teardown = async () => {
    await Promise.all(contexts.splice(0).map((c) => c.close().catch(() => undefined)));
  };

  const work = (async () => {
    stage("Opening the page on desktop");
    const desktopContext = await browser.newContext({
      viewport: DESKTOP,
      acceptDownloads: false,
      serviceWorkers: "block",
      javaScriptEnabled: true,
    });
    contexts.push(desktopContext);
    const page = await desktopContext.newPage();
    page.setDefaultTimeout(10_000);
    page.on("dialog", (d) => d.dismiss().catch(() => undefined));
    let httpStatus: number | null = null;
    try {
      const response = await page.goto(target.toString(), { waitUntil: "load", timeout: navigationTimeout });
      httpStatus = response?.status() ?? null;
    } catch (err) {
      throw describeNavigationError(err, target.toString(), opts.proxyReason);
    }
    if (httpStatus !== null && httpStatus >= 400) {
      notes.push(`The server answered with HTTP ${httpStatus}; the captured page may be an error page.`);
    }
    await settle(page);

    stage("Capturing desktop screenshots");
    const desktop = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY });
    await preloadBelowTheFold(page, MAX_FULL_PAGE_HEIGHT);
    const fullPageHeight = num(await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)));
    const clippedHeight = Math.min(fullPageHeight, MAX_FULL_PAGE_HEIGHT);
    const desktopFull = await page.screenshot({
      type: "jpeg",
      quality: JPEG_QUALITY,
      fullPage: true,
      clip: { x: 0, y: 0, width: DESKTOP.width, height: Math.max(clippedHeight, DESKTOP.height) },
    });
    if (fullPageHeight > MAX_FULL_PAGE_HEIGHT) {
      notes.push(`The full page is ${fullPageHeight}px tall; the full-page capture stops at ${MAX_FULL_PAGE_HEIGHT}px.`);
    }
    const desktopFrames = await captureFrames(page, DESKTOP, fullPageHeight, MAX_DESKTOP_FRAMES);

    stage("Checking page structure");
    const pageFacts = sanitizePageFacts(await page.evaluate(collectPageFacts));
    const title = clip(await page.title(), TITLE_MAX);
    const finalUrl = clip(page.url(), URL_MAX);
    if (finalUrl !== target.toString()) notes.push(`The address redirected to ${finalUrl}.`);

    stage("Opening the page on a phone-sized screen");
    const mobileContext = await browser.newContext({
      viewport: MOBILE,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    contexts.push(mobileContext);
    const mobilePage = await mobileContext.newPage();
    mobilePage.setDefaultTimeout(10_000);
    mobilePage.on("dialog", (d) => d.dismiss().catch(() => undefined));
    try {
      await mobilePage.goto(finalUrl, { waitUntil: "load", timeout: navigationTimeout });
    } catch (err) {
      throw describeNavigationError(err, finalUrl, opts.proxyReason);
    }
    await settle(mobilePage);
    stage("Capturing the mobile screenshots");
    const mobile = await mobilePage.screenshot({ type: "jpeg", quality: JPEG_QUALITY });
    await preloadBelowTheFold(mobilePage, MAX_FULL_PAGE_HEIGHT);
    const mobileHeight = num(await mobilePage.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)));
    const mobileFull = await mobilePage.screenshot({
      type: "jpeg",
      quality: JPEG_QUALITY,
      fullPage: true,
      clip: { x: 0, y: 0, width: MOBILE.width, height: Math.max(Math.min(mobileHeight, MAX_FULL_PAGE_HEIGHT), MOBILE.height) },
    });
    const mobileFrames = await captureFrames(mobilePage, MOBILE, mobileHeight, MAX_MOBILE_FRAMES);
    const mobileFacts = sanitizeMobileFacts(await mobilePage.evaluate(collectMobileFacts, MOBILE.width));

    stage("Writing the report");
    const result: AuditResult = {
      requestedUrl: target.toString(),
      finalUrl,
      title,
      httpStatus,
      capturedAt: new Date().toISOString(),
      viewports: { desktop: DESKTOP, mobile: MOBILE },
      fullPageHeight,
      coverage: {
        desktopFrames: desktopFrames.length,
        desktopHeight: fullPageHeight,
        desktopCovered: Math.min(fullPageHeight, desktopFrames.length * DESKTOP.height),
        mobileFrames: mobileFrames.length,
        mobileHeight,
        mobileCovered: Math.min(mobileHeight, mobileFrames.length * MOBILE.height),
      },
      checks: evaluateChecks(pageFacts, mobileFacts),
      facts: { page: pageFacts, mobile: mobileFacts },
      notes,
    };
    return { result, screenshots: { desktop, desktopFull, mobile, mobileFull, desktopFrames, mobileFrames } };
  })();

  try {
    return await withDeadline(work, opts.deadlineMs ?? 75_000, teardown);
  } finally {
    await forceTeardown(teardown);
  }
}
