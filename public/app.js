// UXAudit front end. Everything coming back from the server describes an
// untrusted web page or an AI's opinion of it, so it is only ever inserted as
// text, never as HTML.

const form = document.getElementById("form");
const input = document.getElementById("url");
const analyzeButton = document.getElementById("analyze");
const status = document.getElementById("status");
const report = document.getElementById("report");
const recentList = document.getElementById("recent");
const recentEmpty = document.getElementById("recent-empty");
const rowTemplate = document.getElementById("check-row");
const reviewItemTemplate = document.getElementById("review-item");

const STATUS_LABEL = { fail: "Problem", warn: "Warning", pass: "Pass", info: "Note" };
const ORDER = { fail: 0, warn: 1, pass: 2, info: 3 };
const RECENT_KEY = "uxaudit.recent";
let currentId = null;

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

const ERROR_TITLES = {
  blocked: "That address can't be analyzed",
  unreachable: "The site could not be reached",
  timeout: "The site took too long to load",
  failed: "The analysis failed",
};

async function analyze(url) {
  analyzeButton.disabled = true;
  report.hidden = true;
  showStatus(status, "running", "Checking the address", url);
  try {
    const { id } = await api("/api/audits", { method: "POST", body: JSON.stringify({ url }) });
    const job = await pollJob(
      id,
      (j) => j.status === "queued" || j.status === "running",
      (j) => showStatus(status, "running", j.stage || "Working", url),
    );
    if (job.status === "error") {
      showStatus(status, "error", ERROR_TITLES[job.error.kind] || ERROR_TITLES.failed, job.error.message);
      return;
    }
    status.hidden = true;
    rememberRecent(id, job.result);
    renderReport(id, job);
    renderRecent();
  } catch (err) {
    showStatus(status, "error", "The analysis could not start", err.message);
  } finally {
    analyzeButton.disabled = false;
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderReport(id, job) {
  const result = job.result;
  currentId = id;
  document.getElementById("report-title").textContent = result.title || "(untitled page)";
  const urlLink = document.getElementById("report-url");
  urlLink.textContent = result.finalUrl;
  urlLink.href = /^https?:/i.test(result.finalUrl) ? result.finalUrl : "#";
  document.getElementById("report-time").textContent = `· captured ${formatTime(result.capturedAt)}`;
  document.getElementById("report-notes").textContent = result.notes.join(" ");
  document.getElementById("shot-desktop").src = `/api/audits/${id}/images/desktop`;
  document.getElementById("shot-mobile").src = `/api/audits/${id}/images/mobile`;
  document.getElementById("full-link").href = `/api/audits/${id}/images/desktop-full`;
  document.getElementById("full-link-mobile").href = `/api/audits/${id}/images/mobile-full`;

  const counts = { fail: 0, warn: 0, pass: 0, info: 0 };
  for (const c of result.checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const parts = [];
  if (counts.fail) parts.push(`${counts.fail} problem${counts.fail === 1 ? "" : "s"}`);
  if (counts.warn) parts.push(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`);
  parts.push(`${counts.pass} passed`);
  if (counts.info) parts.push(`${counts.info} not applicable`);
  document.getElementById("checks-summary").textContent = parts.join(" · ");

  const list = document.getElementById("checks");
  list.replaceChildren();
  for (const check of [...result.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status])) {
    const node = rowTemplate.content.firstElementChild.cloneNode(true);
    node.classList.add(`check--${check.status}`);
    node.querySelector(".check__status").textContent = STATUS_LABEL[check.status] || check.status;
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

  showReviewState(id, job.review);

  report.hidden = false;
  report.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- AI review ---------- */

const reviewStatus = document.getElementById("review-status");
const reviewRetry = document.getElementById("review-retry");
const reviewBody = document.getElementById("review-body");
const reviewButton = document.getElementById("review-button");

function resetReviewSection() {
  reviewRetry.hidden = true;
  reviewButton.disabled = false;
  reviewStatus.hidden = true;
  reviewBody.hidden = true;
}

function renderItems(listId, items, withPriority) {
  const list = document.getElementById(listId);
  list.replaceChildren();
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "review__item";
    li.textContent = "None reported.";
    list.append(li);
    return;
  }
  for (const item of items) {
    const node = reviewItemTemplate.content.firstElementChild.cloneNode(true);
    const priority = node.querySelector(".review__item-priority");
    if (withPriority && item.priority) {
      priority.textContent = item.priority;
      priority.dataset.priority = item.priority;
    }
    node.querySelector(".review__item-name").textContent = item.title;
    node.querySelector(".review__item-location").textContent = item.location;
    node.querySelector(".review__item-evidence").textContent = item.evidence;
    node.querySelector(".review__item-why").textContent = item.explanation;
    const rec = node.querySelector(".review__item-rec");
    if (item.recommendation) {
      rec.textContent = `Suggestion: ${item.recommendation}`;
      rec.hidden = false;
    }
    list.append(node);
  }
}

function renderReview(review) {
  reviewRetry.hidden = true;
  reviewStatus.hidden = true;
  document.getElementById("review-score").textContent = review.overallScore === null ? "–" : String(review.overallScore);
  document.getElementById("review-reason").textContent = review.overallScore === null
    ? `No score: ${review.scoreReason || "the model judged the evidence insufficient."}`
    : review.scoreReason;
  renderItems("review-strengths", review.strengths, false);
  renderItems("review-weaknesses", review.weaknesses, true);
  const limits = document.getElementById("review-limits");
  limits.replaceChildren();
  for (const text of review.limitations.length ? review.limitations : ["The model did not list limitations."]) {
    const li = document.createElement("li");
    li.textContent = text;
    limits.append(li);
  }
  document.getElementById("review-meta").textContent = `Generated by ${review.model} in ${(review.durationMs / 1000).toFixed(1)} s · ${formatTime(review.generatedAt)}`;
  reviewBody.hidden = false;
}

function showReviewFailure(error) {
  const quota = error.kind === "quota" || error.kind === "config";
  showStatus(reviewStatus, "error", quota ? "AI review is not available right now" : "The AI review failed", error.message);
  reviewRetry.hidden = quota;
}

/** Called when a report is shown: the review is already running (or has already finished or failed) on the server. */
function showReviewState(id, reviewState) {
  resetReviewSection();
  if (!reviewState) {
    showStatus(reviewStatus, "running", "Reviewing the screenshots", "Usually about 30 seconds.");
    watchReview(id);
    return;
  }
  if (reviewState.status === "done") renderReview(reviewState.result);
  else if (reviewState.status === "error") showReviewFailure(reviewState.error);
  else {
    showStatus(reviewStatus, "running", "Reviewing the screenshots", "Usually about 30 seconds.");
    watchReview(id);
  }
}

async function watchReview(id) {
  try {
    const job = await pollJob(id, (j) => !j.review || j.review.status === "queued" || j.review.status === "running", () => undefined, 180000);
    if (!job.review || job.review.status === "error") {
      showReviewFailure(job.review ? job.review.error : { message: "The review did not complete.", kind: "failed" });
      return;
    }
    renderReview(job.review.result);
  } catch (err) {
    showStatus(reviewStatus, "error", "The AI review failed", err.message);
    reviewRetry.hidden = false;
  }
}

reviewButton.addEventListener("click", async () => {
  if (!currentId) return;
  reviewButton.disabled = true;
  reviewRetry.hidden = true;
  showStatus(reviewStatus, "running", "Reviewing the screenshots", "Usually about 30 seconds.");
  try {
    await api(`/api/audits/${currentId}/review`, { method: "POST" });
    watchReview(currentId);
  } catch (err) {
    showReviewFailure({ message: err.message, kind: err.status === 429 || err.status === 503 ? "quota" : "failed" });
    reviewButton.disabled = false;
  }
});

/* ---------- Recent audits (kept in this browser) ---------- */

function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRecent(entries) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(entries.slice(0, 20)));
  } catch {
    // storage unavailable: the list is a convenience only
  }
}

function rememberRecent(id, result) {
  const entries = readRecent().filter((e) => e.id !== id);
  entries.unshift({
    id,
    url: result.finalUrl,
    title: result.title,
    capturedAt: result.capturedAt,
    failed: result.checks.filter((c) => c.status === "fail").length,
  });
  writeRecent(entries);
}

function forgetRecent(id) {
  writeRecent(readRecent().filter((e) => e.id !== id));
}

function renderRecent() {
  const audits = readRecent();
  recentList.replaceChildren();
  recentEmpty.hidden = audits.length > 0;
  for (const audit of audits) {
    const li = document.createElement("li");
    li.className = "recent__item";
    const link = document.createElement("a");
    link.className = "recent__link";
    link.href = `#${audit.id}`;
    link.textContent = audit.title || "(untitled page)";
    const url = document.createElement("span");
    url.className = "recent__url";
    url.textContent = audit.url;
    link.append(url);
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        const job = await api(`/api/audits/${audit.id}`);
        if (job.result) renderReport(audit.id, job);
      } catch (err) {
        if (err.status === 404) {
          forgetRecent(audit.id);
          renderRecent();
        }
        showStatus(status, "error", "Could not open that audit", err.status === 404 ? "It has expired and was deleted from the server." : err.message);
      }
    });
    const counts = document.createElement("span");
    counts.className = "recent__counts";
    counts.textContent = `${audit.failed} problem${audit.failed === 1 ? "" : "s"} · ${formatTime(audit.capturedAt)}`;
    const del = document.createElement("button");
    del.className = "recent__delete";
    del.type = "button";
    del.textContent = "Delete";
    del.setAttribute("aria-label", `Delete audit of ${audit.url}`);
    del.addEventListener("click", async () => {
      try {
        await api(`/api/audits/${audit.id}`, { method: "DELETE" });
      } catch (err) {
        if (err.status !== 404) {
          showStatus(status, "error", "Could not delete that audit", err.message);
          return;
        }
      }
      forgetRecent(audit.id);
      renderRecent();
      if (currentId === audit.id) report.hidden = true;
    });
    li.append(link, counts, del);
    recentList.append(li);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) {
    input.focus();
    return;
  }
  analyze(url);
});

renderRecent();
