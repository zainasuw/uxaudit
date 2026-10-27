// UXAudit front end. Everything coming back from the server describes an
// untrusted web page or an AI's opinion of it, so it is only ever inserted as
// text, never as HTML. Audit history lives in this browser only (localStorage).

const $ = (id) => document.getElementById(id);

const form = $("form");
const input = $("url");
const analyzeButton = $("analyze");
const stepper = $("stepper");
const pipeline = $("pipeline");
const stageNodes = [...pipeline.querySelectorAll(".stage")];
const historyList = $("history-list");
const historyEmpty = $("history-empty");
const historyAll = $("history-all");
const historySub = $("history-sub");
const checkTemplate = $("check-row");
const strengthTemplate = $("strength-item");
const issueTemplate = $("issue-item");
const historyRowTemplate = $("history-row");
const narrowScreen = window.matchMedia("(max-width: 699px)");

const STATUS_LABEL = { fail: "Problem", warn: "Warning", pass: "Pass", info: "Not applicable" };
const ORDER = { fail: 0, warn: 1, pass: 2, info: 3 };
const ID_PATTERN = /^[0-9a-f]{24}$/;
const THUMB_PATTERN = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const CODE_PATTERN = /^[0-9a-f]{32}$/;
const HISTORY_KEY = "uxaudit.history.v1";
const ACTIVE_KEY = "uxaudit.active";
const CODES_KEY = "uxaudit.deleteCodes";
const CODE_TTL_MS = 60 * 60 * 1000; // the server keeps an audit for about an hour
const HISTORY_MAX = 20;
const RECENT_COUNT = 3;

let currentId = null; // audit shown in the report view
let pipelineId = null; // audit the progress card describes
let run = 0; // bumps whenever the workspace is reset so stale polling loops stop

class Cancelled extends Error {}

/* ---------- Server ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) {
    const err = new Error((body && body.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a job until it leaves the given pending states; waits grow so an idle tab does not hammer the server. */
async function pollJob(id, isPending, onTick, maxMs = 120000) {
  const started = Date.now();
  let wait = 500;
  for (;;) {
    await sleep(wait);
    wait = Math.min(wait * 1.25, 3000);
    const job = await api(`/api/audits/${id}`);
    if (!isPending(job)) return job;
    onTick(job);
    if (Date.now() - started > maxMs) throw new Error("This is taking longer than expected. Please try again.");
  }
}

const reviewPending = (job) => !job.review || job.review.status === "queued" || job.review.status === "running";

const ERROR_TITLES = {
  blocked: "That address can't be analyzed",
  unreachable: "The site could not be reached",
  timeout: "The site took too long to load",
  failed: "The analysis failed",
};

/* ---------- Browser storage ---------- */

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};

function isEntry(e) {
  return !!e && typeof e === "object" && ID_PATTERN.test(e.id) && typeof e.url === "string" && typeof e.title === "string" && typeof e.capturedAt === "string" && !!e.counts;
}

function loadHistory() {
  try {
    const list = JSON.parse(storage.get(HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** Saves newest-first; when the browser's quota is hit, drops the heaviest data from the oldest entries first. */
function saveHistory(list) {
  const trimmed = list.slice(0, HISTORY_MAX);
  for (let attempt = 0; attempt <= HISTORY_MAX; attempt++) {
    if (storage.set(HISTORY_KEY, JSON.stringify(trimmed))) return;
    const victim = [...trimmed].reverse().find((e) => e.report || e.thumb);
    if (!victim) return;
    delete victim.report;
    victim.thumb = null;
  }
}

/* Delete codes: the server hands one to the browser that starts an audit and only
   that code can delete it from the server. Each is kept as { code, at } for as long
   as the server copy can exist (about an hour); after that there is nothing left to
   delete. Losing one (cleared site data) only means the server copy expires on its own. */

function loadCodes() {
  try {
    const codes = JSON.parse(storage.get(CODES_KEY) || "{}");
    return codes && typeof codes === "object" && !Array.isArray(codes) ? codes : {};
  } catch {
    return {};
  }
}

const isLiveCode = (item) =>
  !!item && typeof item === "object" && typeof item.code === "string" && CODE_PATTERN.test(item.code) &&
  typeof item.at === "number" && Date.now() - item.at < CODE_TTL_MS;

/** Writes the codes back, dropping any that have expired. */
function saveCodes(codes) {
  const live = {};
  for (const [id, item] of Object.entries(codes)) {
    if (ID_PATTERN.test(id) && isLiveCode(item)) live[id] = { code: item.code, at: item.at };
  }
  storage.set(CODES_KEY, JSON.stringify(live));
}

function rememberCode(id, code) {
  if (!ID_PATTERN.test(id) || typeof code !== "string" || !CODE_PATTERN.test(code)) return;
  saveCodes({ ...loadCodes(), [id]: { code, at: Date.now() } });
}

/** The audit's delete code, or null when this browser never had one or it has expired. */
function codeFor(id) {
  const item = loadCodes()[id];
  return isLiveCode(item) ? item.code : null;
}

function forgetCode(id) {
  const codes = loadCodes();
  delete codes[id];
  saveCodes(codes);
}

const findEntry = (id) => loadHistory().find((e) => e.id === id);

function updateHistory(id, patch) {
  const list = loadHistory();
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) return;
  list[i] = typeof patch === "function" ? patch(list[i]) : { ...list[i], ...patch };
  saveHistory(list);
  renderHistory();
}

function countChecks(checks) {
  const counts = { fail: 0, warn: 0, pass: 0, info: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  return counts;
}

function reviewSummary(review) {
  if (!review || review.status === "queued" || review.status === "running") return { status: "pending", score: null };
  if (review.status === "error") return { status: "error", score: null };
  const score = review.result?.overallScore;
  return { status: "done", score: typeof score === "number" ? score : null };
}

function saveHistoryFromJob(id, job) {
  const r = job.result;
  const { facts, ...result } = r; // the raw page facts are large and never displayed
  const previous = findEntry(id);
  const entry = {
    id,
    url: r.finalUrl,
    title: r.title || hostOf(r.finalUrl),
    capturedAt: r.capturedAt,
    counts: countChecks(r.checks),
    review: reviewSummary(job.review),
    thumb: previous?.thumb ?? null,
    report: { result, review: job.review?.status === "done" ? job.review.result : null },
  };
  saveHistory([entry, ...loadHistory().filter((e) => e.id !== id)]);
  renderHistory();
}

/** Keeps a small copy of the desktop screenshot so history still has a real preview after the server forgets the audit. */
function captureThumb(id) {
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 218;
      canvas.height = 138;
      const sourceHeight = Math.min(img.naturalHeight, (img.naturalWidth * canvas.height) / canvas.width);
      canvas.getContext("2d").drawImage(img, 0, 0, img.naturalWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      updateHistory(id, { thumb: canvas.toDataURL("image/jpeg", 0.72) });
    } catch { /* the server image stays the fallback */ }
  };
  img.src = `/api/audits/${id}/images/desktop`;
}

function removeEntry(id) {
  const code = codeFor(id);
  forgetCode(id);
  saveHistory(loadHistory().filter((e) => e.id !== id));
  renderHistory();
  // Best effort: without a code (or if this fails) the server copy simply expires within the hour.
  if (code) api(`/api/audits/${id}`, { method: "DELETE", headers: { "x-delete-code": code } }).catch(() => undefined);
  if (currentId === id) {
    currentId = null;
    if (document.body.dataset.view === "report") showView("history");
  }
  if (pipelineId === id) {
    run++; // stop following it, or the tracker would save it back into history when it finishes
    setBusy(false);
    showIdle();
  }
}

/* ---------- Formatting ---------- */

function formatTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function displayUrl(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname) + u.search;
  } catch {
    return url;
  }
}

/* ---------- Progress card ---------- */

const STAGE_RING = { done: "/assets/stage-done.svg", active: "/assets/stage-active.svg", pending: "/assets/stage-pending.svg", failed: "/assets/stage-pending.svg" };
const STAGE_MARK = { done: "/assets/check.svg", active: "/assets/sparkle.svg" };
const STAGE_WORDS = { done: "complete", active: "in progress", pending: "not started", failed: "stopped" };

/**
 * Maps a job onto the five visible stages: 0 URL verified, 1 Screenshots,
 * 2 Heuristic checks, 3 AI analysis, 4 Report. `active` is 5 once all are done.
 */
function describeJob(job) {
  const stage = job?.stage || "";
  if (!job || job.status === "queued") {
    return { active: 0, title: "Checking the address", sub: stage === "Waiting" ? "Waiting for a free slot. Audits run one at a time." : "Making sure the site is public and reachable." };
  }
  if (job.status === "running") {
    if (/address/i.test(stage)) return { active: 0, title: "Checking the address", sub: "Making sure the site is public and reachable." };
    if (/report/i.test(stage)) return { active: 2, title: "Running the measured checks", sub: "Screenshots captured. Checking structure, labels and the mobile layout." };
    return { active: 1, title: "Capturing screenshots", sub: stage ? `${stage}.` : "Loading the page in a clean browser." };
  }
  if (reviewPending(job)) {
    return { active: 3, title: "Analyzing the page's visual design", sub: "Screenshots captured. The AI critic is reviewing every frame now, usually about 30 seconds." };
  }
  if (job.review.status === "error") {
    return { active: 5, failed: 3, state: "warning", eyebrow: "Audit complete", title: "Report ready, without an AI review", sub: job.review.error?.message || "The AI review did not complete." };
  }
  return { active: 5, state: "done", eyebrow: "Audit complete", title: "Audit complete", sub: "Opening your design review." };
}

function errorView(title, message, failedAt = 0) {
  return { active: failedAt, failed: failedAt, state: "error", eyebrow: "Audit stopped", title, sub: message };
}

function renderPipeline(view, id) {
  pipelineId = id;
  stepper.hidden = true;
  pipeline.hidden = false;
  pipeline.dataset.state = view.state || "running";
  $("pipeline-eyebrow").textContent = view.eyebrow || "Review in progress";
  $("pipeline-title").textContent = view.title;
  $("pipeline-sub").textContent = view.sub || "";
  stageNodes.forEach((node, i) => {
    const state = view.failed === i ? "failed" : i < view.active ? "done" : i === view.active ? "active" : "pending";
    node.dataset.state = state;
    node.querySelector(".stage__ring").src = STAGE_RING[state];
    const mark = node.querySelector(".stage__mark");
    mark.hidden = !STAGE_MARK[state];
    if (STAGE_MARK[state]) mark.src = STAGE_MARK[state];
    node.querySelector(".stage__state").textContent = `: ${STAGE_WORDS[state]}`;
  });
}

function showNotice(title, message) {
  showView("workspace");
  renderPipeline({ active: 0, state: "notice", eyebrow: "History", title, sub: message }, null);
}

function showIdle() {
  pipeline.hidden = true;
  stepper.hidden = false;
  pipelineId = null;
}

function setBusy(busy) {
  analyzeButton.disabled = busy;
  analyzeButton.classList.toggle("is-busy", busy);
  analyzeButton.querySelector(".button__label").textContent = busy ? "Analyzing…" : "Run audit";
  analyzeButton.querySelector(".button__arrow").hidden = busy;
}

/* ---------- Running an audit ---------- */

async function analyze(url) {
  const token = ++run;
  currentId = null;
  showView("workspace");
  setBusy(true);
  renderPipeline(describeJob(null), null);
  try {
    const { id, deleteCode } = await api("/api/audits", { method: "POST", body: JSON.stringify({ url }) });
    rememberCode(id, deleteCode); // stored before the cancellation check; an unused code just expires
    if (token !== run) return;
    storage.set(ACTIVE_KEY, id);
    pipelineId = id;
    await trackJob(id, token);
  } catch (err) {
    if (err instanceof Cancelled || token !== run) return;
    renderPipeline(errorView("The analysis could not start", err.message), null);
  } finally {
    if (token === run) setBusy(false);
  }
}

/** Follows a job through capture, checks and the AI review, then opens the report. */
async function trackJob(id, token) {
  const check = () => { if (token !== run) throw new Cancelled(); };
  let lastActive = 0;
  const job = await pollJob(id, (j) => j.status === "queued" || j.status === "running", (j) => {
    check();
    const view = describeJob(j);
    lastActive = view.active;
    renderPipeline(view, id);
  });
  check();
  storage.remove(ACTIVE_KEY);
  if (job.status === "error") {
    renderPipeline(errorView(ERROR_TITLES[job.error.kind] || ERROR_TITLES.failed, job.error.message, lastActive), id);
    return;
  }
  renderPipeline(describeJob(job), id);
  saveHistoryFromJob(id, job); // saved before the review so the audit survives a closed tab
  captureThumb(id);

  let finalJob = job;
  if (reviewPending(job)) {
    try {
      finalJob = await pollJob(id, reviewPending, check, 180000);
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      finalJob = { ...job, review: { status: "error", error: { kind: "failed", message: err.message } } };
    }
  }
  check();
  renderPipeline(describeJob(finalJob), id);
  saveHistoryFromJob(id, finalJob);
  await sleep(700); // let the completed stages register before the report takes over
  check();
  openReport(id, finalJob);
}

/** Picks up an audit that was still running when the page was last closed or reloaded. */
async function resume() {
  const id = storage.get(ACTIVE_KEY);
  if (!id || !ID_PATTERN.test(id)) return;
  try {
    const job = await api(`/api/audits/${id}`);
    if (job.status === "done") {
      storage.remove(ACTIVE_KEY);
      input.value = job.url;
      saveHistoryFromJob(id, job); // it finished while the page was closed, so give it its history row
      captureThumb(id);
      openReport(id, job);
      return;
    }
    if (job.status === "error") {
      storage.remove(ACTIVE_KEY);
      return;
    }
    input.value = job.url;
    await followRunning(id, job);
  } catch {
    storage.remove(ACTIVE_KEY);
  }
}

async function followRunning(id, job) {
  const token = ++run;
  showView("workspace");
  setBusy(true);
  renderPipeline(describeJob(job), id);
  try {
    await trackJob(id, token);
  } catch (err) {
    if (err instanceof Cancelled || token !== run) return;
    renderPipeline(errorView("The analysis failed", err.message), id);
  } finally {
    if (token === run) setBusy(false);
  }
}

/* ---------- Report ---------- */

function openReport(id, job, options) {
  renderReport(id, job, options);
  showView("report");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderReport(id, job, { stored = false, thumb = null } = {}) {
  const result = job.result;
  currentId = id;
  const urlPill = $("report-url");
  urlPill.textContent = displayUrl(result.finalUrl);
  urlPill.href = /^https?:/i.test(result.finalUrl) ? result.finalUrl : "#";
  $("report-time").textContent = `Captured ${formatTime(result.capturedAt)}`;
  $("report-notes").textContent = result.notes.join(" ");

  const expired = $("report-expired");
  const evidence = document.querySelector(".evidence");
  expired.hidden = !stored;
  evidence.hidden = stored;
  const savedThumb = $("report-thumb");
  savedThumb.hidden = !(stored && thumb && THUMB_PATTERN.test(thumb));
  if (!savedThumb.hidden) savedThumb.src = thumb;
  if (!stored) {
    $("shot-desktop").src = `/api/audits/${id}/images/desktop`;
    $("shot-mobile").src = `/api/audits/${id}/images/mobile`;
    $("full-link").href = `/api/audits/${id}/images/desktop-full`;
    $("full-link-mobile").href = `/api/audits/${id}/images/mobile-full`;
    $("shot-desktop-note").textContent = `${result.title ? `“${result.title}” · ` : ""}Top of the page at 1280 px wide. Expand shows the full-length capture.`;
  }

  const counts = countChecks(result.checks);
  const parts = [];
  if (counts.fail) parts.push(`${counts.fail} problem${counts.fail === 1 ? "" : "s"}`);
  if (counts.warn) parts.push(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`);
  parts.push(`${counts.pass} passed`);
  if (counts.info) parts.push(`${counts.info} not applicable`);
  $("checks-summary").textContent = parts.join(" · ");

  const list = $("checks");
  list.replaceChildren();
  for (const check of [...result.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status])) {
    const node = checkTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(`check--${check.status}`);
    node.querySelector(".check__status").textContent = `${STATUS_LABEL[check.status] || check.status}.`;
    node.querySelector(".check__title").textContent = check.title;
    node.querySelector(".check__line").textContent = check.summary;
    node.querySelector(".check__meaning").textContent = check.meaning;
    node.querySelector(".check__fix span").textContent = check.fix;
    const examples = node.querySelector(".check__examples");
    for (const example of check.examples) {
      const li = document.createElement("li");
      li.textContent = example;
      examples.append(li);
    }
    if (check.status === "fail") node.querySelector("details").open = true;
    list.append(node);
  }

  showReviewState(id, job.review, stored);
}

/** Shows a report that only survives in this browser's history (the server has already dropped it). */
function renderStoredReport(entry) {
  const result = entry.report?.result;
  if (!result || !Array.isArray(result.checks) || !Array.isArray(result.notes)) {
    showNotice("This audit is no longer available", "Reports stay on the server for about an hour. Use Re-audit to capture the page again.");
    return;
  }
  const review = entry.report.review
    ? { status: "done", result: entry.report.review }
    : { status: "error", error: { kind: "expired", message: entry.review?.status === "error" ? "The AI review did not complete for this audit." : "The AI review for this audit is no longer available." } };
  openReport(entry.id, { result, review }, { stored: true, thumb: entry.thumb });
}

/* ---------- AI review ---------- */

const reviewStatus = $("review-status");
const reviewRetry = $("review-retry");
const reviewButton = $("review-button");

function showStatus(el, kind, title, detail) {
  el.hidden = false;
  el.className = `status status--${kind}`;
  el.replaceChildren();
  const h = document.createElement("p");
  h.className = "status__title";
  h.textContent = title;
  el.append(h);
  if (detail) {
    const p = document.createElement("p");
    p.className = "status__detail";
    p.textContent = detail;
    el.append(p);
  }
}

function clearReview() {
  reviewRetry.hidden = true;
  reviewButton.disabled = false;
  reviewStatus.hidden = true;
  $("review-reason").textContent = "";
  $("review-limits-label").hidden = true;
  $("review-limits").replaceChildren();
  $("review-score").textContent = "—";
  $("review-meta").textContent = "";
  for (const listId of ["review-strengths", "review-weaknesses"]) $(listId).replaceChildren(panelNote("The AI review has not completed yet."));
}

function panelNote(text) {
  const li = document.createElement("li");
  li.className = "panel__empty";
  li.textContent = text;
  return li;
}

function renderStrengths(items) {
  const list = $("review-strengths");
  list.replaceChildren();
  if (!items.length) {
    list.append(panelNote("The review did not report any strengths."));
    return;
  }
  items.forEach((item, i) => {
    const node = strengthTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".strength__num").textContent = String(i + 1).padStart(2, "0");
    node.querySelector(".strength__title").textContent = item.title;
    node.querySelector(".strength__evidence").textContent = item.location ? `${item.location} — ${item.evidence}` : item.evidence;
    node.querySelector(".strength__why").textContent = item.explanation;
    list.append(node);
  });
}

function renderIssues(items) {
  const list = $("review-weaknesses");
  list.replaceChildren();
  if (!items.length) {
    list.append(panelNote("The review did not report anything that needs attention."));
    return;
  }
  for (const item of items) {
    const node = issueTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".issue__title").textContent = item.title;
    const priority = node.querySelector(".issue__priority");
    if (item.priority) {
      priority.textContent = `Priority ${item.priority}`;
      priority.classList.toggle("issue__priority--high", /^high$/i.test(item.priority));
      priority.hidden = false;
    }
    node.querySelector(".issue__evidence").textContent = item.location ? `${item.location} — ${item.evidence}` : item.evidence;
    node.querySelector(".issue__why").textContent = item.explanation;
    if (item.recommendation) {
      node.querySelector(".issue__rec-label").hidden = false;
      const rec = node.querySelector(".issue__rec");
      rec.textContent = item.recommendation;
      rec.hidden = false;
    }
    list.append(node);
  }
}

function renderReview(review) {
  reviewRetry.hidden = true;
  reviewStatus.hidden = true;
  const score = $("review-score");
  score.textContent = review.overallScore === null ? "—" : String(review.overallScore);
  score.setAttribute("aria-label", review.overallScore === null ? "No score" : `${review.overallScore} out of 10`);
  $("review-reason").textContent = review.overallScore === null
    ? `No score: ${review.scoreReason || "the model judged the evidence insufficient."}`
    : review.scoreReason;
  const limits = $("review-limits");
  limits.replaceChildren();
  $("review-limits-label").hidden = review.limitations.length === 0;
  for (const text of review.limitations) {
    const li = document.createElement("li");
    li.textContent = text;
    limits.append(li);
  }
  renderStrengths(review.strengths);
  renderIssues(review.weaknesses);
  $("review-meta").textContent = `AI review generated by ${review.model} in ${(review.durationMs / 1000).toFixed(1)} s · ${formatTime(review.generatedAt)}. It is a design judgement from screenshots and measured checks, not a usability study or an accessibility certification, and it can be wrong.`;
}

function showReviewFailure(error) {
  const final = error.kind === "quota" || error.kind === "config" || error.kind === "expired";
  showStatus(reviewStatus, "error", final ? "AI review is not available right now" : "The AI review failed", error.message);
  reviewRetry.hidden = final;
  for (const listId of ["review-strengths", "review-weaknesses"]) $(listId).replaceChildren(panelNote("No AI review for this audit."));
}

/** Called when a report is shown: the review may already be done, failed, or still running on the server. */
function showReviewState(id, reviewState, stored = false) {
  clearReview();
  if (reviewState?.status === "done") {
    renderReview(reviewState.result);
    return;
  }
  if (reviewState?.status === "error") {
    showReviewFailure(reviewState.error);
    return;
  }
  if (stored) {
    showReviewFailure({ kind: "expired", message: "The AI review for this audit is no longer available." });
    return;
  }
  showStatus(reviewStatus, "running", "Reviewing the screenshots", "Usually about 30 seconds.");
  watchReview(id);
}

async function watchReview(id) {
  try {
    const job = await pollJob(id, reviewPending, () => { if (currentId !== id) throw new Cancelled(); }, 180000);
    if (currentId !== id) return;
    const review = job.review;
    if (!review || review.status === "error") {
      showReviewFailure(review ? review.error : { message: "The review did not complete.", kind: "failed" });
      updateHistory(id, { review: { status: "error", score: null } });
    } else {
      renderReview(review.result);
      updateHistory(id, (entry) => ({ ...entry, review: reviewSummary(review), report: { ...(entry.report || {}), review: review.result } }));
    }
  } catch (err) {
    if (err instanceof Cancelled || currentId !== id) return;
    showStatus(reviewStatus, "error", "The AI review failed", err.message);
    reviewRetry.hidden = false;
  }
}

reviewButton.addEventListener("click", async () => {
  const id = currentId;
  if (!id) return;
  reviewButton.disabled = true;
  reviewRetry.hidden = true;
  showStatus(reviewStatus, "running", "Reviewing the screenshots", "Usually about 30 seconds.");
  try {
    await api(`/api/audits/${id}/review`, { method: "POST" });
    watchReview(id);
  } catch (err) {
    showReviewFailure({ message: err.message, kind: err.status === 429 || err.status === 503 ? "quota" : "failed" });
    reviewButton.disabled = false;
  }
});

/* ---------- History ---------- */

function renderHistory() {
  const list = loadHistory();
  const view = document.body.dataset.view;
  const visible = view === "history" ? list : list.slice(0, RECENT_COUNT);
  historyList.replaceChildren(...visible.map(renderRow));
  historyList.hidden = list.length === 0;
  historyEmpty.hidden = list.length > 0;
  historyAll.hidden = view === "history" || list.length === 0;
  historySub.textContent = list.length === 0
    ? "Your previous design reviews will appear here."
    : narrowScreen.matches ? "Return to previously reviewed websites." : "Your previous design reviews, at a glance.";
}

function renderRow(entry) {
  const node = historyRowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = entry.id;

  const img = node.querySelector(".row__thumb img");
  img.src = entry.thumb && THUMB_PATTERN.test(entry.thumb) ? entry.thumb : `/api/audits/${entry.id}/images/desktop`;
  img.onerror = () => img.remove();

  const title = node.querySelector(".row__title");
  title.textContent = entry.title;
  node.querySelector(".row__url").textContent = displayUrl(entry.url);
  node.querySelector(".row__date").textContent = formatTime(entry.capturedAt);

  const findings = (entry.counts.fail || 0) + (entry.counts.warn || 0);
  const pill = node.querySelector(".row__pill");
  pill.textContent = findings === 0 ? "No findings" : `${findings} finding${findings === 1 ? "" : "s"}`;
  pill.classList.toggle("row__pill--amber", (entry.counts.fail || 0) > 0);

  const review = entry.review || { status: "pending", score: null };
  const hasScore = review.status === "done" && typeof review.score === "number";
  node.querySelector(".row__score-value").textContent = hasScore ? String(review.score) : "—";
  node.querySelector(".row__score-label").textContent = hasScore ? "Score out of 10" : review.status === "done" ? "Not scored" : review.status === "error" ? "No score" : "Score pending";

  const open = () => openEntry(entry.id);
  title.addEventListener("click", open);
  node.querySelector(".row__view").addEventListener("click", open);
  const chevron = node.querySelector(".row__chevron");
  chevron.setAttribute("aria-label", `Open report for ${entry.title}`);
  chevron.addEventListener("click", open);
  node.addEventListener("click", (event) => {
    if (narrowScreen.matches && !event.target.closest("button, a")) open();
  });
  node.querySelector(".row__redo").addEventListener("click", () => reaudit(entry.url));

  const confirm = node.querySelector(".row__confirm");
  const remove = node.querySelector(".row__remove");
  confirm.querySelector(".row__confirm-text").textContent = codeFor(entry.id)
    ? "Remove this audit and its server copy?"
    : "Remove from your history only?";
  const cancel = () => {
    confirm.hidden = true;
    node.classList.remove("row--confirm");
    remove.focus();
  };
  remove.addEventListener("click", () => {
    confirm.hidden = false;
    node.classList.add("row--confirm");
    confirm.querySelector(".row__confirm-no").focus();
  });
  confirm.querySelector(".row__confirm-no").addEventListener("click", cancel);
  confirm.querySelector(".row__confirm-yes").addEventListener("click", () => removeEntry(entry.id));
  confirm.addEventListener("keydown", (event) => { if (event.key === "Escape") cancel(); });
  return node;
}

async function openEntry(id) {
  if (!ID_PATTERN.test(id)) return;
  if (currentId === id && document.body.dataset.view === "report") {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  run++;
  setBusy(false);
  showIdle();
  const entry = findEntry(id);
  try {
    const job = await api(`/api/audits/${id}`);
    if (job.status === "done") {
      if (!reviewPending(job)) saveHistoryFromJob(id, job); // picks up a review that finished while the tab was away
      openReport(id, job);
    } else if (job.status === "error") {
      showView("workspace");
      renderPipeline(errorView(ERROR_TITLES[job.error.kind] || ERROR_TITLES.failed, job.error.message), id);
    } else {
      input.value = job.url;
      await followRunning(id, job);
    }
  } catch (err) {
    if (err.status === 404 && entry?.report) renderStoredReport(entry);
    else if (err.status === 404) showNotice("This audit is no longer available", "Reports stay on the server for about an hour. Use Re-audit to capture the page again.");
    else showNotice("The report could not be loaded", err.message);
  }
}

function reaudit(url) {
  input.value = url;
  analyze(url);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- Views ---------- */

function showView(view) {
  document.body.dataset.view = view;
  renderHistory();
  if (view === "history" && location.hash !== "#history") history.replaceState(null, "", "#history");
  if (view !== "history" && location.hash) history.replaceState(null, "", location.pathname);
}

function resetWorkspace() {
  run++;
  currentId = null;
  setBusy(false);
  showIdle();
  input.value = "";
  storage.remove(ACTIVE_KEY);
  showView("workspace");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

window.addEventListener("hashchange", () => {
  if (location.hash === "#history") showView("history");
  else if (document.body.dataset.view === "history") showView("workspace");
});
narrowScreen.addEventListener("change", renderHistory);

$("nav-new").addEventListener("click", () => {
  resetWorkspace();
  input.focus();
});

$("report-another").addEventListener("click", () => {
  resetWorkspace();
  input.focus();
});

$("history-start").addEventListener("click", () => {
  showView("workspace");
  window.scrollTo({ top: 0, behavior: "smooth" });
  input.focus();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) {
    input.focus();
    return;
  }
  analyze(url);
});

showView(location.hash === "#history" ? "history" : "workspace");
resume();
