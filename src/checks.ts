// Deterministic checks. Each one looks at facts the browser can state with
// certainty (an <img> without alt, a page without an <h1>), explains what the
// fact means for visitors, and says what to change. Nothing here guesses.

export type CheckStatus = "pass" | "fail" | "warn" | "info";
export type Severity = "high" | "medium" | "low";

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  severity: Severity;
  /** One sentence stating what was found, with numbers. */
  summary: string;
  /** Up to a handful of concrete examples taken from the page (plain text). */
  examples: string[];
  /** Why this matters to a visitor. */
  meaning: string;
  /** What to change. */
  fix: string;
}

/** Facts gathered inside the page. Kept as plain data so it serializes. */
export interface PageFacts {
  title: string;
  lang: string | null;
  hasViewportMeta: boolean;
  h1Count: number;
  headingLevels: number[];
  imagesTotal: number;
  imagesWithoutAlt: string[];
  controlsTotal: number;
  controlsWithoutName: string[];
  fieldsTotal: number;
  fieldsWithoutLabel: string[];
  genericLinks: string[];
  textLength: number;
}

export interface MobileFacts {
  scrollWidth: number;
  viewportWidth: number;
  smallTapTargets: string[];
  tapTargetsTotal: number;
}

/**
 * Runs inside the page. It must stay self-contained (no imports, no closures
 * over Node values) because Playwright serializes it into the browser.
 */
export function collectPageFacts(): PageFacts {
  const MAX_EXAMPLES = 5;
  const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const describe = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList.length ? "." + Array.from(el.classList).slice(0, 2).join(".") : "";
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    return clip(`<${tag}${id}${cls}>${text ? " " + clip(text, 40) : ""}`);
  };
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };
  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .trim();
      if (text) return text;
    }
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button" || el.type === "reset")) {
      if (el.value.trim()) return el.value.trim();
    }
    const imgAlt = Array.from(el.querySelectorAll("img[alt], svg[aria-label], [aria-label]"))
      .map((n) => n.getAttribute("alt") || n.getAttribute("aria-label") || "")
      .join(" ")
      .trim();
    if (imgAlt) return imgAlt;
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  };

  const images = Array.from(document.querySelectorAll("img")).filter(visible);
  const imagesWithoutAlt = images
    .filter((img) => !img.hasAttribute("alt") && img.getAttribute("role") !== "presentation")
    .map((img) => clip(img.getAttribute("src") || describe(img)));

  const controls = Array.from(
    document.querySelectorAll<HTMLElement>('a[href], button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"]'),
  ).filter(visible);
  const controlsWithoutName = controls.filter((c) => !accessibleName(c)).map(describe);

  const fields = Array.from(document.querySelectorAll<HTMLElement>("input, select, textarea")).filter(
    (f) => visible(f) && !["hidden", "submit", "button", "reset", "image"].includes((f as HTMLInputElement).type),
  );
  const hasLabel = (f: HTMLElement) => {
    if (accessibleName(f) && (f.getAttribute("aria-label") || f.getAttribute("aria-labelledby") || f.getAttribute("title"))) return true;
    if (f.id && document.querySelector(`label[for="${CSS.escape(f.id)}"]`)) return true;
    if (f.closest("label")) return true;
    return false;
  };
  const fieldsWithoutLabel = fields.filter((f) => !hasLabel(f)).map(describe);

  const GENERIC = new Set(["click here", "here", "read more", "more", "learn more", "link", "this"]);
  const genericLinks = Array.from(document.querySelectorAll("a[href]"))
    .filter(visible)
    .filter((a) => GENERIC.has((a.textContent || "").replace(/\s+/g, " ").trim().toLowerCase()))
    .map(describe);

  const headingLevels = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .filter(visible)
    .map((h) => Number(h.tagName[1]));

  return {
    title: document.title.trim(),
    lang: document.documentElement.getAttribute("lang"),
    hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
    h1Count: headingLevels.filter((l) => l === 1).length,
    headingLevels,
    imagesTotal: images.length,
    imagesWithoutAlt: imagesWithoutAlt.slice(0, MAX_EXAMPLES),
    controlsTotal: controls.length,
    controlsWithoutName: controlsWithoutName.slice(0, MAX_EXAMPLES),
    fieldsTotal: fields.length,
    fieldsWithoutLabel: fieldsWithoutLabel.slice(0, MAX_EXAMPLES),
    genericLinks: genericLinks.slice(0, MAX_EXAMPLES),
    textLength: (document.body?.innerText || "").length,
  };
}

/**
 * Runs inside the page at the mobile viewport. Self-contained, see above.
 * `deviceWidth` is passed in from Node: without a viewport meta tag the
 * browser widens its layout viewport to fit the content, so window.innerWidth
 * cannot be trusted to represent the phone's screen.
 */
export function collectMobileFacts(deviceWidth: number): MobileFacts {
  const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const targets = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, [role="button"], input, select, textarea')).filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight;
  });
  const small = targets.filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width < 24 || rect.height < 24;
  });
  return {
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    viewportWidth: deviceWidth,
    tapTargetsTotal: targets.length,
    smallTapTargets: small
      .slice(0, 5)
      .map((el) => clip(`<${el.tagName.toLowerCase()}> ${(el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40)} (${Math.round(el.getBoundingClientRect().width)}×${Math.round(el.getBoundingClientRect().height)}px)`)),
  };
}

function skippedHeadingLevels(levels: number[]): string[] {
  const skips: string[] = [];
  let previous = 0;
  for (const level of levels) {
    if (previous && level > previous + 1) skips.push(`h${previous} → h${level}`);
    previous = level;
  }
  return skips.slice(0, 5);
}

export function evaluateChecks(page: PageFacts, mobile: MobileFacts | null): CheckResult[] {
  const results: CheckResult[] = [];

  results.push({
    id: "title",
    title: "Page title",
    severity: "medium",
    status: page.title ? "pass" : "fail",
    summary: page.title ? `The page is titled “${page.title.slice(0, 80)}”.` : "The page has no title.",
    examples: [],
    meaning: "The title is what browser tabs, bookmarks, search results and screen readers show first. Without it, visitors cannot tell what the page is before reading it.",
    fix: "Add a <title> in <head> that names the page and the site, for example “Pricing – Acme”.",
  });

  results.push({
    id: "lang",
    title: "Page language",
    severity: "low",
    status: page.lang ? "pass" : "warn",
    summary: page.lang ? `The document declares its language as “${page.lang}”.` : "The <html> element has no lang attribute.",
    examples: [],
    meaning: "Screen readers choose pronunciation rules from the declared language, and browsers use it for translation offers and hyphenation.",
    fix: 'Add lang to the <html> element, for example <html lang="en">.',
  });

  results.push({
    id: "viewport",
    title: "Mobile viewport",
    severity: "high",
    status: page.hasViewportMeta ? "pass" : "fail",
    summary: page.hasViewportMeta ? "A viewport meta tag is present." : "There is no viewport meta tag.",
    examples: [],
    meaning: "Without it, phones render the page at desktop width and shrink it, so text becomes tiny and visitors must pinch-zoom to read anything.",
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>.',
  });

  results.push({
    id: "h1",
    title: "Main heading",
    severity: "medium",
    status: page.h1Count === 1 ? "pass" : page.h1Count === 0 ? "fail" : "warn",
    summary:
      page.h1Count === 1
        ? "The page has exactly one main heading (h1)."
        : page.h1Count === 0
          ? "The page has no h1 heading."
          : `The page has ${page.h1Count} h1 headings.`,
    examples: [],
    meaning: "The h1 tells visitors and assistive technology what the page is about. Zero makes the page harder to orient in; several compete for that role.",
    fix: "Use one h1 that states the page's purpose, and h2–h6 for the sections beneath it.",
  });

  const skips = skippedHeadingLevels(page.headingLevels);
  results.push({
    id: "heading-order",
    title: "Heading structure",
    severity: "low",
    status: page.headingLevels.length === 0 ? "info" : skips.length ? "warn" : "pass",
    summary:
      page.headingLevels.length === 0
        ? "No headings were found."
        : skips.length
          ? `Heading levels are skipped ${skips.length} time${skips.length === 1 ? "" : "s"} (${skips.join(", ")}).`
          : `${page.headingLevels.length} headings form a consistent outline.`,
    examples: [],
    meaning: "Headings are the page's outline. Skipping levels (h2 straight to h4) makes the outline misleading for people who navigate by headings.",
    fix: "Nest headings in order: h1, then h2 for sections, h3 for subsections. Style them with CSS rather than picking a level for its default size.",
  });

  results.push({
    id: "img-alt",
    title: "Image descriptions",
    severity: "high",
    status: page.imagesTotal === 0 ? "info" : page.imagesWithoutAlt.length ? "fail" : "pass",
    summary:
      page.imagesTotal === 0
        ? "No visible images were found."
        : page.imagesWithoutAlt.length
          ? `${page.imagesWithoutAlt.length === 5 ? "At least " : ""}${page.imagesWithoutAlt.length} of ${page.imagesTotal} visible images have no alt attribute.`
          : `All ${page.imagesTotal} visible images have an alt attribute.`,
    examples: page.imagesWithoutAlt,
    meaning: "Alt text is what screen readers announce and what shows when an image fails to load. An image with no alt attribute is announced by its file name or skipped entirely.",
    fix: 'Give meaningful images a short alt describing their content; give purely decorative images alt="" so they are skipped on purpose.',
  });

  results.push({
    id: "control-names",
    title: "Buttons and links with names",
    severity: "high",
    status: page.controlsTotal === 0 ? "info" : page.controlsWithoutName.length ? "fail" : "pass",
    summary:
      page.controlsTotal === 0
        ? "No visible buttons or links were found."
        : page.controlsWithoutName.length
          ? `${page.controlsWithoutName.length === 5 ? "At least " : ""}${page.controlsWithoutName.length} of ${page.controlsTotal} visible buttons and links have no accessible name.`
          : `All ${page.controlsTotal} visible buttons and links have an accessible name.`,
    examples: page.controlsWithoutName,
    meaning: "An icon-only button with no name is announced as just “button”, so keyboard and screen-reader users cannot tell what it does.",
    fix: "Add visible text, or aria-label on the control, or alt on the icon inside it.",
  });

  results.push({
    id: "form-labels",
    title: "Form field labels",
    severity: "medium",
    status: page.fieldsTotal === 0 ? "info" : page.fieldsWithoutLabel.length ? "fail" : "pass",
    summary:
      page.fieldsTotal === 0
        ? "No visible form fields were found."
        : page.fieldsWithoutLabel.length
          ? `${page.fieldsWithoutLabel.length === 5 ? "At least " : ""}${page.fieldsWithoutLabel.length} of ${page.fieldsTotal} visible form fields have no label.`
          : `All ${page.fieldsTotal} visible form fields have a label.`,
    examples: page.fieldsWithoutLabel,
    meaning: "Placeholder text disappears while typing and is not read as a label. Fields without a label are hard to fill in correctly and impossible to identify with assistive technology.",
    fix: "Pair each field with a <label for=\"…\">, or wrap the field in its label; use aria-label only when a visible label is impossible.",
  });

  results.push({
    id: "generic-links",
    title: "Descriptive link text",
    severity: "low",
    status: page.genericLinks.length ? "warn" : "pass",
    summary: page.genericLinks.length
      ? `${page.genericLinks.length === 5 ? "At least " : ""}${page.genericLinks.length} links use generic text such as “click here” or “read more”.`
      : "No links rely on generic text such as “click here”.",
    examples: page.genericLinks,
    meaning: "People scan links out of context (and screen readers can list them). “Read more” says nothing about the destination.",
    fix: "Make the link text name the destination or the action: “Read the pricing details” instead of “Read more”.",
  });

  if (mobile) {
    const overflow = mobile.scrollWidth - mobile.viewportWidth;
    results.push({
      id: "mobile-overflow",
      title: "Horizontal scrolling on mobile",
      severity: "high",
      status: overflow > 2 ? "fail" : "pass",
      summary:
        overflow > 2
          ? `At ${mobile.viewportWidth}px wide the page is ${mobile.scrollWidth}px wide, so it scrolls sideways by ${overflow}px.`
          : `At ${mobile.viewportWidth}px wide the page fits without sideways scrolling.`,
      examples: [],
      meaning: "Sideways scrolling on a phone usually means a fixed-width element or an image wider than the screen; content gets cut off and the layout feels broken.",
      fix: "Find the element wider than the viewport (often an image, table or a fixed width in px) and let it shrink with max-width: 100% or a responsive layout.",
    });

    results.push({
      id: "tap-targets",
      title: "Tap target size on mobile",
      severity: "medium",
      status: mobile.tapTargetsTotal === 0 ? "info" : mobile.smallTapTargets.length ? "warn" : "pass",
      summary:
        mobile.tapTargetsTotal === 0
          ? "No tappable controls were visible in the first screen on mobile."
          : mobile.smallTapTargets.length
            ? `${mobile.smallTapTargets.length === 5 ? "At least " : ""}${mobile.smallTapTargets.length} of ${mobile.tapTargetsTotal} controls in the first mobile screen are smaller than 24×24px.`
            : `All ${mobile.tapTargetsTotal} controls in the first mobile screen are at least 24×24px.`,
      examples: mobile.smallTapTargets,
      meaning: "Fingers are imprecise. Controls under about 24px are easy to miss or to tap by accident, especially when several sit close together.",
      fix: "Give links and buttons enough padding to reach at least 24×24px (44×44px is more comfortable) and space them apart.",
    });
  }

  return results;
}
