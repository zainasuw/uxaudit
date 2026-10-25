import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { collectMobileFacts, collectPageFacts, evaluateChecks, type CheckResult, type MobileFacts, type PageFacts } from "./checks.js";
import { BlockedUrlError, createHostGuard, parseTargetUrl, type HostGuard, type Lookup } from "./url-guard.js";

export interface Screenshots {
  desktop: Buffer;
  desktopFull: Buffer;
  mobile: Buffer;
}

export interface AuditResult {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  httpStatus: number | null;
  capturedAt: string;
  viewports: { desktop: { width: number; height: number }; mobile: { width: number; height: number } };
  fullPageHeight: number;
  checks: CheckResult[];
  facts: { page: PageFacts; mobile: MobileFacts };
  notes: string[];
}

export interface AnalyzeOptions {
  /** Tests only: lets the fixture server on 127.0.0.1 through the network guard. */
  allowPrivate?: boolean;
  lookup?: Lookup;
  onStage?: (stage: string) => void;
  navigationTimeoutMs?: number;
}

export class AnalyzeError extends Error {
  constructor(message: string, public kind: "blocked" | "unreachable" | "timeout" | "failed") {
    super(message);
    this.name = "AnalyzeError";
  }
}

const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };
const MAX_FULL_PAGE_HEIGHT = 5000;
const SETTLE_MS = 800;

let browserPromise: Promise<Browser> | null = null;

async function browser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, handleSIGINT: false }).then((b) => {
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

export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  if (pending) await (await pending).close().catch(() => undefined);
}

/** Every request the page makes goes through the same public-host rule as the pasted URL. */
async function guardContext(context: BrowserContext, guard: HostGuard | null): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!/^https?:/i.test(url)) return route.abort("blockedbyclient");
    if (guard) {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return route.abort("blockedbyclient");
      }
      if (!(await guard.isPublic(host))) return route.abort("blockedbyclient");
    }
    return route.continue();
  });
}

function describeNavigationError(err: unknown, url: string): AnalyzeError {
  const message = err instanceof Error ? err.message : String(err);
  if (/Timeout/i.test(message)) return new AnalyzeError(`${url} did not finish loading within the time limit.`, "timeout");
  if (/ERR_NAME_NOT_RESOLVED/.test(message)) return new AnalyzeError(`The address ${url} could not be found (DNS lookup failed).`, "unreachable");
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_TIMED_OUT/.test(message)) {
    return new AnalyzeError(`${url} refused the connection or closed it.`, "unreachable");
  }
  if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/.test(message)) {
    return new AnalyzeError(`${url} tried to reach a private or local network address, so the analysis was stopped.`, "blocked");
  }
  if (/ERR_CERT|SSL/.test(message)) return new AnalyzeError(`${url} has an invalid HTTPS certificate.`, "unreachable");
  return new AnalyzeError(`Could not load ${url}: ${message.split("\n")[0]}`, "failed");
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
  // When run through tsx, serialized functions reference a `__name` helper
  // that does not exist inside the page. A harmless shim keeps evaluation working.
  await page.evaluate("window.__name = window.__name || function (fn) { return fn; }").catch(() => undefined);
}

export async function analyzeUrl(input: unknown, opts: AnalyzeOptions = {}): Promise<{ result: AuditResult; screenshots: Screenshots }> {
  const stage = opts.onStage ?? (() => undefined);
  let target: URL;
  try {
    target = parseTargetUrl(input, { allowPrivate: opts.allowPrivate });
  } catch (err) {
    throw new AnalyzeError(err instanceof Error ? err.message : String(err), "blocked");
  }
  const guard = opts.allowPrivate ? null : createHostGuard(opts.lookup);
  if (guard) {
    const verdict = await guard.classify(target.hostname);
    if (verdict === "unresolvable") {
      throw new AnalyzeError(`The address ${target.hostname} could not be found (DNS lookup failed). Check the spelling.`, "unreachable");
    }
    if (verdict === "private") {
      throw new AnalyzeError("That address points to a private, local or reserved network, so it cannot be analyzed.", "blocked");
    }
  }

  const notes: string[] = [];
  const b = await browser();
  const navigationTimeout = opts.navigationTimeoutMs ?? 25_000;

  stage("Opening the page on desktop");
  const desktopContext = await b.newContext({
    viewport: DESKTOP,
    acceptDownloads: false,
    serviceWorkers: "block",
    javaScriptEnabled: true,
  });
  let mobileContext: BrowserContext | null = null;
  try {
    await guardContext(desktopContext, guard);
    const page = await desktopContext.newPage();
    page.setDefaultTimeout(10_000);
    let httpStatus: number | null = null;
    try {
      const response = await page.goto(target.toString(), { waitUntil: "load", timeout: navigationTimeout });
      httpStatus = response?.status() ?? null;
    } catch (err) {
      throw describeNavigationError(err, target.toString());
    }
    if (httpStatus !== null && httpStatus >= 400) {
      notes.push(`The server answered with HTTP ${httpStatus}; the captured page may be an error page.`);
    }
    await settle(page);

    stage("Capturing desktop screenshots");
    const desktop = await page.screenshot({ type: "png" });
    const fullPageHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    const clippedHeight = Math.min(fullPageHeight, MAX_FULL_PAGE_HEIGHT);
    const desktopFull = await page.screenshot({
      type: "png",
      fullPage: true,
      clip: { x: 0, y: 0, width: DESKTOP.width, height: Math.max(clippedHeight, DESKTOP.height) },
    });
    if (fullPageHeight > MAX_FULL_PAGE_HEIGHT) {
      notes.push(`The full page is ${fullPageHeight}px tall; the full-page capture stops at ${MAX_FULL_PAGE_HEIGHT}px.`);
    }

    stage("Checking page structure");
    const pageFacts = await page.evaluate(collectPageFacts);
    const title = await page.title();
    const finalUrl = page.url();
    if (finalUrl !== target.toString()) notes.push(`The address redirected to ${finalUrl}.`);

    stage("Opening the page on a phone-sized screen");
    mobileContext = await b.newContext({
      viewport: MOBILE,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await guardContext(mobileContext, guard);
    const mobilePage = await mobileContext.newPage();
    mobilePage.setDefaultTimeout(10_000);
    try {
      await mobilePage.goto(finalUrl, { waitUntil: "load", timeout: navigationTimeout });
    } catch (err) {
      throw describeNavigationError(err, finalUrl);
    }
    await settle(mobilePage);
    stage("Capturing the mobile screenshot");
    const mobile = await mobilePage.screenshot({ type: "png" });
    const mobileFacts = await mobilePage.evaluate(collectMobileFacts, MOBILE.width);

    stage("Writing the report");
    const result: AuditResult = {
      requestedUrl: target.toString(),
      finalUrl,
      title,
      httpStatus,
      capturedAt: new Date().toISOString(),
      viewports: { desktop: DESKTOP, mobile: MOBILE },
      fullPageHeight,
      checks: evaluateChecks(pageFacts, mobileFacts),
      facts: { page: pageFacts, mobile: mobileFacts },
      notes,
    };
    return { result, screenshots: { desktop, desktopFull, mobile } };
  } finally {
    await desktopContext.close().catch(() => undefined);
    await mobileContext?.close().catch(() => undefined);
  }
}

export { BlockedUrlError };
