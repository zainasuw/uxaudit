// UXAudit front end. Everything coming back from the server describes an
// untrusted web page, so it is only ever inserted as text, never as HTML.

const form = document.getElementById("form");
const input = document.getElementById("url");
const analyzeButton = document.getElementById("analyze");
const status = document.getElementById("status");
const report = document.getElementById("report");
const recentList = document.getElementById("recent");
const recentEmpty = document.getElementById("recent-empty");
const rowTemplate = document.getElementById("check-row");

const STATUS_LABEL = { fail: "Problem", warn: "Warning", pass: "Pass", info: "Note" };
const ORDER = { fail: 0, warn: 1, pass: 2, info: 3 };

function showStatus(kind, title, detail) {
  status.hidden = false;
  status.className = `status status--${kind}`;
  status.replaceChildren();
  const h = document.createElement("p");
  h.className = "status__title";
  h.textContent = title;
  status.append(h);
  if (detail) {
    const p = document.createElement("p");
    p.className = "status__detail";
    p.textContent = detail;
    status.append(p);
  }
}

function hideStatus() {
  status.hidden = true;
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error((body && body.error) || `${res.status} ${res.statusText}`);
  return body;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function analyze(url) {
  analyzeButton.disabled = true;
  report.hidden = true;
  showStatus("running", "Checking the address", url);
  try {
    const { id } = await api("/api/audits", { method: "POST", body: JSON.stringify({ url }) });
    for (;;) {
      await sleep(600);
      const job = await api(`/api/audits/${id}`);
      if (job.status === "done") {
        hideStatus();
        renderReport(id, job.result);
        await loadRecent();
        return;
      }
      if (job.status === "error") {
        const titles = {
          blocked: "That address can't be analyzed",
          unreachable: "The site could not be reached",
          timeout: "The site took too long to load",
          failed: "The analysis failed",
        };
        showStatus("error", titles[job.error.kind] || titles.failed, job.error.message);
        return;
      }
      showStatus("running", job.stage || "Working", url);
    }
  } catch (err) {
    showStatus("error", "The analysis could not start", err.message);
  } finally {
    analyzeButton.disabled = false;
  }
}

function formatTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function renderReport(id, result) {
  document.getElementById("report-title").textContent = result.title || "(untitled page)";
  const urlLink = document.getElementById("report-url");
  urlLink.textContent = result.finalUrl;
  urlLink.href = result.finalUrl;
  document.getElementById("report-time").textContent = `· captured ${formatTime(result.capturedAt)}`;
  document.getElementById("report-notes").textContent = result.notes.join(" ");
  document.getElementById("shot-desktop").src = `/api/audits/${id}/images/desktop`;
  document.getElementById("shot-mobile").src = `/api/audits/${id}/images/mobile`;
  document.getElementById("full-link").href = `/api/audits/${id}/images/desktop-full`;

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
  const sorted = [...result.checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  for (const check of sorted) {
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

  report.hidden = false;
  report.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadRecent() {
  let audits = [];
  try {
    audits = await api("/api/audits");
  } catch {
    return;
  }
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
        if (job.result) renderReport(audit.id, job.result);
      } catch (err) {
        showStatus("error", "Could not open that audit", err.message);
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
        await loadRecent();
      } catch (err) {
        showStatus("error", "Could not delete that audit", err.message);
      }
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

loadRecent();
