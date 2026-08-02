let data = null;
let requests = null;
let searchedCompaniesLive = null;
let activeTab = "best";
let summaryFilter = null;
let companyStats = new Map(); // company (lowercase) -> { applied, rejected }

const content = document.querySelector("#content");
const summary = document.querySelector("#summary");
const metaLine = document.querySelector("#metaLine");
const controls = document.querySelector(".controls");
const textFilter = document.querySelector("#textFilter");
const statusFilter = document.querySelector("#statusFilter");
const priHigh = document.querySelector("#priHigh");
const priMed = document.querySelector("#priMed");
const priLow = document.querySelector("#priLow");
const locSwiss = document.querySelector("#locSwiss");
const peerFilter = document.querySelector("#peerFilter");
const sortControl = document.querySelector("#sortControl");
const saveStatus = document.querySelector("#saveStatus");
const runClaudeButton = document.querySelector("#runClaudeButton");
const runCodexButton = document.querySelector("#runCodexButton");

// ---- auto-save ----
let saveTimer = null;
let saving = false;
let pendingSave = false;

function setSaveStatus(text, cls) {
  if (!saveStatus) return;
  saveStatus.textContent = text;
  saveStatus.className = "save-status" + (cls ? " " + cls : "");
}

const MAX_SAVE_RETRIES = 3;
let saveFailures = 0;

async function flushSave() {
  saveTimer = null;
  if (saving) { pendingSave = true; return; }
  saving = true;
  setSaveStatus("Saving…", "saving");
  try {
    const res = await fetch("/api/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    const p = await res.json();
    data.meta.updatedAt = p.updatedAt;
    saveFailures = 0;
    pendingSave = false;
    setSaveStatus("Saved", "ok");
    updateMeta();
  } catch (e) {
    saveFailures += 1;
    if (saveFailures <= MAX_SAVE_RETRIES) {
      // Backoff capped at a few attempts; stop the retry loop after that.
      setSaveStatus(`Save failed — retry ${saveFailures}/${MAX_SAVE_RETRIES}`, "err");
      saving = false;
      window.setTimeout(flushSave, 600 * saveFailures);
      return;
    }
    setSaveStatus("Save failed — edit again to retry", "err");
    pendingSave = false;
  } finally {
    saving = false;
    if (pendingSave) { pendingSave = false; window.setTimeout(flushSave, 600); }
  }
}

function scheduleSave(immediate = false) {
  window.clearTimeout(saveTimer);
  saveTimer = null;
  saveFailures = 0; // a fresh edit resets the retry budget
  if (immediate) { flushSave(); return; }
  setSaveStatus("Saving…", "saving");
  saveTimer = window.setTimeout(flushSave, 700);
}

const statusOptions = [
  { value: "NEW", label: "New" },
  { value: "OPEN", label: "Open" },
  { value: "APPLIED", label: "Applied" },
  { value: "DECLINED", label: "Declined" },
  { value: "ARCHIVED", label: "Archived" }
];
const statusLabels = new Map(statusOptions.map((o) => [o.value, o.label]));
const linkStatusLabels = new Map([
  ["VERIFIED", "Apply verified"],
  ["DIRECT", "Direct posting"],
  ["SEARCH", "Search page"],
  ["UNVERIFIED", "Unverified"],
  ["STALE", "Stale / filled"]
]);
const priorityLabels = new Map([["HIGH", "High"], ["MEDIUM", "Medium"], ["LOW", "Low"]]);
const priorityWeight = new Map([["HIGH", 3], ["MEDIUM", 2], ["LOW", 1]]);
const activeStatuses = new Set(["NEW", "OPEN"]);
const ARCHIVE_AGE_DAYS = 30;

const SWISS_HINTS = ["switzerland", "swiss", "zurich", "zürich", "zug", "geneva", "genève", "geneve", "basel", "bern", "lausanne", "gland", "rüschlikon", "ruschlikon", "lugano", "winterthur", "(ch", " ch)", ", ch"];
function isSwiss(location = "") {
  const l = String(location).toLowerCase();
  return SWISS_HINTS.some((hint) => l.includes(hint));
}

// Age is measured from createdDate (when added), not lastUpdate, so family edits
// don't reset the auto-archive clock. Mirrors the server.
function ageDays(role) {
  const ref = role.createdDate || role.updatedAt;
  if (!ref) return 0;
  const then = new Date(ref).getTime();
  if (Number.isNaN(then)) return 0;
  return (Date.now() - then) / 86400000;
}
function computeStatus(role) {
  if (role.userRejected || role.status === "DECLINED") return "DECLINED";
  if (role.userApplied || role.status === "APPLIED") return "APPLIED";
  if (role.status === "ARCHIVED" || ageDays(role) >= ARCHIVE_AGE_DAYS) return "ARCHIVED";
  return role.status === "NEW" ? "NEW" : "OPEN";
}
function roleScore(role) {
  return (priorityWeight.get(role.priority) ?? 1)
    + (computeStatus(role) === "NEW" ? 1 : 0)
    + (isSwiss(role.location) ? 2 : 0)
    + (role.peerReviewed ? 1 : 0);
}

function escapeHtml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Key matching skills to bold in role descriptions (the candidate's strengths).
const SKILL_CI = ["JavaScript", "TypeScript", "Java", "Python", "Kotlin", "Scala", "React", "Angular", "Kafka", "Elasticsearch", "PostgreSQL", "trading", "productivity", "agentic", "agents?", "distributed systems", "low-latency", "real-time", "quant", "automation", "execution"];
const SKILL_CS = ["GenAI", "LLMs?", "AI", "ML", "JS\\/TS", "JS", "TS"];
const skillCiRe = new RegExp("\\b(" + SKILL_CI.join("|") + ")\\b", "gi");
const skillCsRe = new RegExp("\\b(" + SKILL_CS.join("|") + ")\\b", "g");
// Input must already be HTML-escaped; we only inject <strong> wrappers.
function highlightSkills(escaped = "") {
  return escaped.replace(skillCiRe, "<strong>$1</strong>").replace(skillCsRe, "<strong>$1</strong>");
}
function optionHtml(options, selected, includeAll = false) {
  const rows = includeAll ? [`<option value="">All statuses</option>`] : [];
  for (const o of options) rows.push(`<option value="${escapeHtml(o.value)}" ${o.value === selected ? "selected" : ""}>${escapeHtml(o.label)}</option>`);
  return rows.join("");
}
function safeUrl(value = "") {
  const url = String(value).trim();
  return /^https?:\/\//.test(url) ? url : "";
}
function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "link"; }
}

// ---- filtering / sorting ----

const isRolesTab = () => activeTab === "best" || activeTab === "all";

function rowText(role) {
  return Object.values(role).join(" ").toLowerCase();
}
function baseRolesForTab() {
  const roles = data.roles ?? [];
  if (activeTab === "applications") return roles.filter((r) => computeStatus(r) === "APPLIED");
  if (activeTab === "best") return roles.filter((r) => activeStatuses.has(computeStatus(r)));
  return roles; // all
}
function matchesSummaryFilter(role) {
  if (!summaryFilter) return true;
  if (summaryFilter === "unreviewed") return !role.peerReviewed;
  return computeStatus(role) === summaryFilter;
}
function filteredRoles() {
  let rows = baseRolesForTab();
  if (isRolesTab()) {
    const term = textFilter.value.trim().toLowerCase();
    const status = statusFilter.value;
    const peer = peerFilter.value;
    const prios = [priHigh.checked && "HIGH", priMed.checked && "MEDIUM", priLow.checked && "LOW"].filter(Boolean);
    const swissOnly = locSwiss.checked;
    rows = rows.filter((role) => {
      if (term && !rowText(role).includes(term)) return false;
      if (!matchesSummaryFilter(role)) return false;
      if (status && computeStatus(role) !== status) return false;
      if (prios.length && !prios.includes(role.priority)) return false;
      if (swissOnly && !isSwiss(role.location)) return false;
      if (peer === "yes" && !role.peerReviewed) return false;
      if (peer === "no" && role.peerReviewed) return false;
      return true;
    });
    const sort = sortControl.value;
    // "Newest" sorts by createdDate (the date shown on each row); the others fall back to it.
    const byCreated = (a, b) => String(b.createdDate || b.lastUpdate || "").localeCompare(String(a.createdDate || a.lastUpdate || ""));
    if (sort === "newest") rows = [...rows].sort(byCreated);
    else if (sort === "company") rows = [...rows].sort((a, b) => String(a.company).localeCompare(String(b.company)) || byCreated(a, b));
    else rows = [...rows].sort((a, b) => roleScore(b) - roleScore(a) || byCreated(a, b));
  } else {
    rows = [...rows].sort((a, b) => String(b.appliedDate || b.lastUpdate || "").localeCompare(String(a.appliedDate || a.lastUpdate || "")));
  }
  return rows;
}

// ---- summary ----

function renderSummary() {
  if (!isRolesTab()) { summary.innerHTML = ""; summary.style.display = "none"; return; }
  summary.style.display = "";
  const roles = baseRolesForTab();
  const counts = roles.reduce((acc, r) => {
    acc.total += 1;
    acc[computeStatus(r)] = (acc[computeStatus(r)] ?? 0) + 1;
    if (!r.peerReviewed) acc.unreviewed += 1;
    return acc;
  }, { total: 0, unreviewed: 0 });
  // Best jobs only ever contains NEW/OPEN, so only show cards that can actually filter it.
  const metrics = activeTab === "best"
    ? [
        { key: null, label: "Total", value: counts.total, tone: "neutral" },
        { key: "NEW", label: "New", value: counts.NEW ?? 0, tone: "go" },
        { key: "OPEN", label: "Open", value: counts.OPEN ?? 0, tone: "info" },
        { key: "unreviewed", label: "Unreviewed", value: counts.unreviewed, tone: "warn" }
      ]
    : [
        { key: null, label: "Total", value: counts.total, tone: "neutral" },
        { key: "NEW", label: "New", value: counts.NEW ?? 0, tone: "go" },
        { key: "OPEN", label: "Open", value: counts.OPEN ?? 0, tone: "info" },
        { key: "APPLIED", label: "Applied", value: counts.APPLIED ?? 0, tone: "info" },
        { key: "DECLINED", label: "Declined", value: counts.DECLINED ?? 0, tone: "bad" },
        { key: "ARCHIVED", label: "Archived", value: counts.ARCHIVED ?? 0, tone: "neutral" },
        { key: "unreviewed", label: "Unreviewed", value: counts.unreviewed, tone: "warn" }
      ];
  summary.innerHTML = metrics.map((m) => `
    <button class="metric tone-${m.tone} ${summaryFilter === m.key ? "active" : ""}" data-summary="${escapeHtml(String(m.key))}">
      <strong>${m.value}</strong><span>${escapeHtml(m.label)}</span>
    </button>`).join("");
}

// ---- rows ----

const priorityShort = new Map([["HIGH", "H"], ["MEDIUM", "M"], ["LOW", "L"]]);
function priorityBadge(role) {
  const p = role.priority;
  const letter = priorityShort.get(p) ?? "?";
  const label = priorityLabels.get(p) ?? "Unset";
  const cls = p ? "pr-" + escapeHtml(p) : "pr-NONE";
  return `<span class="prio ${cls}" title="${escapeHtml(label)} priority">${letter}</span>`;
}

// ---- company history ----

// Classify a role into exactly one history bucket (or null if it doesn't count):
//   employerRejected — base status DECLINED (employer said no, confirmed from email)
//   selfRejected     — family ticked Reject (our own decline), not an employer rejection
//   applied          — application submitted and still pending (display APPLIED)
function historyBucket(role) {
  if (role.status === "DECLINED") return "employerRejected"; // employer rejection (locks the checkbox)
  const ds = computeStatus(role);
  if (ds === "DECLINED") return "selfRejected"; // userRejected without an employer rejection
  if (ds === "APPLIED") return "applied";
  return null;
}

function buildCompanyStats() {
  const cutoff = Date.now() - 90 * 86400000;
  companyStats = new Map();
  for (const role of (data?.roles ?? [])) {
    const bucket = historyBucket(role);
    if (!bucket) continue;
    const dateStr = role.appliedDate || role.lastUpdate || role.createdDate;
    const ts = dateStr ? new Date(dateStr).getTime() : 0;
    if (!ts || ts < cutoff) continue;
    const key = (role.company || "").toLowerCase();
    if (!key) continue;
    if (!companyStats.has(key)) companyStats.set(key, { applied: 0, employerRejected: 0, selfRejected: 0 });
    companyStats.get(key)[bucket]++;
  }
}

function getCompanyHistory(role) {
  const key = (role.company || "").toLowerCase();
  const co = companyStats.get(key);
  if (!co) return null;
  const out = { applied: co.applied, employerRejected: co.employerRejected, selfRejected: co.selfRejected };
  // Subtract this role's own contribution so we show OTHER roles at the company.
  const bucket = historyBucket(role);
  if (bucket) {
    const cutoff = Date.now() - 90 * 86400000;
    const dateStr = role.appliedDate || role.lastUpdate || role.createdDate;
    const ts = dateStr ? new Date(dateStr).getTime() : 0;
    if (ts >= cutoff) out[bucket]--;
  }
  return (out.applied + out.employerRejected + out.selfRejected) > 0 ? out : null;
}

function displayDate(role) {
  const ds = computeStatus(role);
  return (ds === "APPLIED" && role.appliedDate) ? role.appliedDate : (role.createdDate || "");
}
function displayDateTitle(role) {
  const ds = computeStatus(role);
  return ds === "APPLIED" ? "Applied date" : "Added to registry";
}

function chip(label, value, cls = "") {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return `<span class="chip ${cls}"><span>${escapeHtml(label)}</span>${escapeHtml(text)}</span>`;
}
function linkChip(role) {
  const url = safeUrl(role.link);
  if (!url) return `<span class="chip muted"><span>Link</span>none</span>`;
  return `<a class="chip link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span>↗</span>${escapeHtml(hostLabel(url))}</a>`;
}

function kvList(label, arr, cls) {
  if (!Array.isArray(arr) || !arr.length) return "";
  return `<div class="kv"><span>${label}</span><ul class="kv-list ${cls}">${arr.map((x) => `<li>${highlightSkills(escapeHtml(String(x)))}</li>`).join("")}</ul></div>`;
}

function detailBlock(role) {
  const parts = [];
  const history = getCompanyHistory(role);
  if (history) {
    const msgs = [];
    if (history.employerRejected > 0) msgs.push(`${history.employerRejected} rejected by employer`);
    if (history.selfRejected > 0) msgs.push(`${history.selfRejected} declined by you`);
    if (history.applied > 0) msgs.push(`${history.applied} applied/pending`);
    const cls = history.employerRejected > 0 ? "warn" : "info";
    parts.push(`<div class="co-history co-history-${cls}">Other roles at ${escapeHtml(role.company)} in last 90 days: ${msgs.join(", ")}</div>`);
  }
  // Comp range: always shown so every job displays one (fallback when unstated).
  parts.push(`<div class="kv"><span>Comp range</span><p>${role.salaryRange ? highlightSkills(escapeHtml(role.salaryRange)) : `<span class="muted">not stated — estimate pending</span>`}</p></div>`);
  // Pros / Cons split (structured); fall back to the legacy fit/risk blob.
  const pros = Array.isArray(role.pros) ? role.pros : [];
  const cons = Array.isArray(role.cons) ? role.cons : [];
  if (pros.length || cons.length) {
    parts.push(kvList("Pros", pros, "pros"));
    parts.push(kvList("Cons", cons, "cons"));
  } else if (role.fitRiskSummary) {
    parts.push(`<div class="kv"><span>Fit / risk</span><p>${highlightSkills(escapeHtml(role.fitRiskSummary))}</p></div>`);
  }
  if (role.nextAction) parts.push(`<div class="kv"><span>Next action</span><p>${escapeHtml(role.nextAction)}</p></div>`);
  if (role.statusNote) parts.push(`<div class="kv"><span>Status note</span><p>${escapeHtml(role.statusNote)}</p></div>`);
  const meta = [
    chip("ID", role.internalId),
    chip("Link", linkStatusLabels.get(role.linkStatus) ?? role.linkStatus, "ls-" + escapeHtml(role.linkStatus || "NONE")),
    linkChip(role),
    chip("Priority", priorityLabels.get(role.priority) ?? role.priority),
    role.peerReviewed ? `<span class="chip ok"><span>✓</span>reviewed</span>` : `<span class="chip warn"><span>!</span>unreviewed</span>`
  ].join("");
  const actions = `<div class="detail-actions">
    <button class="cl-btn" data-coverletter="${escapeHtml(role.id)}" data-mode="letter">✉ Cover letter</button>
    <button class="cl-btn cl-btn-alt" data-coverletter="${escapeHtml(role.id)}" data-mode="questions">📝 Answer form questions</button>
  </div>`;
  return `<div class="row-detail"><div class="chips">${meta}</div>${parts.join("")}${actions}</div>`;
}

function roleRow(role) {
  const index = data.roles.indexOf(role);
  const ds = computeStatus(role);
  const swiss = isSwiss(role.location);
  const appliedLocked = role.status === "APPLIED";   // confirmed by email scan
  const rejectLocked = role.status === "DECLINED";    // employer rejection confirmed by email scan
  const appliedChecked = role.userApplied || appliedLocked;
  const rejectChecked = role.userRejected || rejectLocked;
  const appliedTitle = appliedLocked ? "Applied — confirmed from email scan (locked)" : "Mark as applied";
  const rejectTitle = rejectLocked ? "Rejected by employer — confirmed from email scan (locked)" : "Mark as rejected/declined";
  const unverified = role.linkStatus === "UNVERIFIED";
  return `<div class="row ${swiss ? "" : "foreign"} st-row-${ds}${unverified ? " ls-unverified" : ""}">
    <div class="row-line">
      <button class="exp" data-exp title="Details">▸</button>
      ${priorityBadge(role)}
      <span class="added" title="${escapeHtml(displayDateTitle(role))}">${escapeHtml(displayDate(role))}</span>
      <span class="who">
        <span class="co">${escapeHtml(role.company)}</span>
        <span class="ro">${escapeHtml(role.role)}</span>
      </span>
      <span class="loc ${swiss ? "swiss" : "foreign"}" title="${escapeHtml(role.location)}">${escapeHtml(role.location || "—")}</span>
      <span class="pill st-${ds}">${escapeHtml(statusLabels.get(ds))}</span>
      <label class="cb ${appliedLocked ? "locked" : ""}" title="${escapeHtml(appliedTitle)}"><input type="checkbox" data-index="${index}" data-field="userApplied" ${appliedChecked ? "checked" : ""} ${appliedLocked ? "disabled" : ""}><span>Applied${appliedLocked ? " 🔒" : ""}</span></label>
      <label class="cb rej ${rejectLocked ? "locked" : ""}" title="${escapeHtml(rejectTitle)}"><input type="checkbox" data-index="${index}" data-field="userRejected" ${rejectChecked ? "checked" : ""} ${rejectLocked ? "disabled" : ""}><span>Reject${rejectLocked ? " 🔒" : ""}</span></label>
      <input class="cmt" type="text" data-index="${index}" data-field="comments" placeholder="comment for the agent (e.g. check location)…" value="${escapeHtml(role.comments || "")}">
    </div>
    ${detailBlock(role)}
  </div>`;
}

function renderRoles() {
  const rows = filteredRoles();
  if (!rows.length) {
    content.innerHTML = `<div class="empty">No roles match.</div>`;
    return;
  }
  content.innerHTML = `<div class="rows">${rows.map(roleRow).join("")}</div>`;
}

function formatRunDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const MODEL_SHORT = {
  "claude-opus-5": "Opus 5",
  "claude-fable-5": "Fable 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "gpt-5.6-sol": "GPT-5.6",
  "gpt-5.5": "GPT-5.5"
};
const EFFORT_SHORT = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

// "Fable 5 · Max thinking" for a run row; "" for requests that never spawned an agent.
function runModelEffort(r) {
  if (!r.model && !r.effort) return "";
  const m = r.model ? (MODEL_SHORT[r.model] || r.model) : "Codex default";
  const e = r.effort ? (EFFORT_SHORT[r.effort] || r.effort) : "";
  return e ? `${m} · ${e} thinking` : m;
}

// Location scope a run was launched with; "" for requests that predate the setting.
function runScope(r) {
  if (typeof r.includeMunichParis !== "boolean") return "";
  return r.includeMunichParis ? "CH + Munich & Paris" : "Switzerland only";
}

// Only shown when a run skipped a step (all-on is the default, so stays quiet).
function runStepsLabel(r) {
  const p = r.phases;
  if (!p) return "";
  const on = [p.search && "search", p.verify && "verify", p.email && "email", p.review && "review"].filter(Boolean);
  if (on.length === 4) return "";
  return on.length ? `steps: ${on.join(", ")}` : "summary only";
}

// "4m 12s" between start and finish; "" while running or if timing is missing.
function runDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return "";
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!(ms > 0)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function renderRequests() {
  const rows = requests.requests ?? [];
  if (!rows.length) { content.innerHTML = `<div class="empty">No activity yet. Click “▶ Run Claude” or “▶ Run Codex” to start a search.</div>`; return; }
  content.innerHTML = `<div class="req-list">
    ${rows.map((r) => {
      const modelEffort = runModelEffort(r);
      const scope = runScope(r);
      const steps = runStepsLabel(r);
      const done = Boolean(r.finishedAt);
      const dur = runDuration(r.startedAt, r.finishedAt);
      return `
      <div class="req">
        <div class="req-type">${escapeHtml(r.type)}<span class="small">${escapeHtml(r.assignedTo || "")}</span>${modelEffort ? `<span class="small run-model">${escapeHtml(modelEffort)}</span>` : ""}${scope ? `<span class="small run-scope">${escapeHtml(scope)}</span>` : ""}${steps ? `<span class="small run-steps-tag">${escapeHtml(steps)}</span>` : ""}</div>
        <div class="req-body"><b>${escapeHtml(r.title || "")}</b><div class="small">${escapeHtml(r.notes || "")}</div></div>
        <div class="req-status">
          <span class="pill rq-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
          <div class="small">${done ? "finished " : ""}${escapeHtml(formatRunDate(r.finishedAt || r.startedAt || r.createdAt))}</div>
          ${done && dur ? `<div class="small">took ${escapeHtml(dur)}</div>` : ""}
          ${r.logPath ? `<a class="link-sm" href="/api/request-log?id=${escapeHtml(r.id)}" target="_blank" rel="noopener noreferrer">Log</a>` : ""}
          ${r.status === "OPEN" && !["MANUAL_NOTE", "RUN_FULL_WORKFLOW", "CLAUDE_FULL_RUN", "CODEX_FULL_RUN"].includes(r.type) ? `<button class="tiny" data-run-request="${escapeHtml(r.id)}">Run</button>` : ""}
        </div>
      </div>`;
    }).join("")}
  </div>`;
}

function latestRunText() {
  const rows = requests?.requests ?? [];
  const runs = rows.filter((r) => ["CLAUDE_FULL_RUN", "CODEX_FULL_RUN", "RUN_FULL_WORKFLOW"].includes(r.type));
  const pool = runs.length ? runs : rows.filter((r) => r.finishedAt || r.startedAt);
  if (!pool.length) return "last run: never";
  const latest = pool.reduce((best, r) =>
    Date.parse(r.finishedAt || r.startedAt || r.createdAt || 0) > Date.parse(best.finishedAt || best.startedAt || best.createdAt || 0) ? r : best);
  return `last run: ${formatRunDate(latest.finishedAt || latest.startedAt || latest.createdAt)}${latest.status ? ` (${latest.status.toLowerCase()})` : ""}`;
}
function updateMeta() {
  const roles = data.roles ?? [];
  const apps = roles.filter((r) => computeStatus(r) === "APPLIED").length;
  const updatedAt = data?.meta?.updatedAt ? new Date(data.meta.updatedAt).toLocaleString() : "not saved yet";
  metaLine.textContent = `${roles.length} roles · ${apps} applied · ${(requests.requests ?? []).length} activity · ${latestRunText()} · saved ${updatedAt}`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Build a concise "added N jobs, archived M jobs, …" list from a run summary.
function changePhrases(r) {
  const out = [];
  if (typeof r.newRoles === "number") out.push(`added ${plural(r.newRoles, "job", "jobs")}`);
  if (typeof r.archived === "number") out.push(`archived ${plural(r.archived, "job", "jobs")}`);
  if (typeof r.removed === "number" && r.removed) out.push(`removed ${plural(r.removed, "job", "jobs")}`);
  const e = r.emails || {};
  if (typeof e.applications === "number" && e.applications) out.push(`${plural(e.applications, "new application", "new applications")}`);
  if (typeof e.replies === "number" && e.replies) out.push(`${plural(e.replies, "reply", "replies")}`);
  if (typeof e.rejections === "number" && e.rejections) out.push(`marked ${plural(e.rejections, "job rejected", "jobs rejected")}`);
  if (typeof e.interviews === "number" && e.interviews) out.push(`${plural(e.interviews, "interview", "interviews")}`);
  return out;
}

function renderRunSummary() {
  summary.innerHTML = ""; summary.style.display = "none";
  const all = (data.runSummaries ?? []);
  // Sort descending by date, then by original array position (later index = newer within same date),
  // so we correctly find the latest even if an agent prepended instead of appended.
  const ranked = all
    .map((s, i) => ({ s, i }))
    .sort((a, b) => String(b.s.date || "").localeCompare(String(a.s.date || "")) || b.i - a.i);
  const latest = ranked[0]?.s ?? null;

  // Companies searched this run come from the run request's server-captured snapshot
  // (the ATS harvest source list, grouped by industry), matched to the latest summary.
  const reqRows = requests?.requests ?? [];
  const hasSnapshot = (r) => Array.isArray(r.searchedCompanies) && r.searchedCompanies.length;
  const searchedReq = (latest?.requestId && reqRows.find((r) => r.id === latest.requestId && hasSnapshot(r)))
    || reqRows.find(hasSnapshot) || null;
  const searched = searchedReq?.searchedCompanies || searchedCompaniesLive || null;
  const searchedCount = searched ? searched.reduce((n, g) => n + g.companies.length, 0) : 0;
  // A searched company "has results" if any tracked role matches its (normalized) name.
  const normCo = (s) => String(s || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  const roleCoKeys = (data.roles || []).map((r) => normCo(r.company)).filter(Boolean);
  const companyHasResults = (name) => {
    const n = normCo(name);
    if (!n) return false;
    const first = n.split(" ")[0];
    return roleCoKeys.some((rk) => rk === n || rk.startsWith(n) || n.startsWith(rk) || (first.length >= 4 && rk.split(" ")[0] === first));
  };
  const withResults = searched ? searched.reduce((acc, g) => acc + g.companies.filter(companyHasResults).length, 0) : 0;
  const searchedSection = searched ? `
      <div class="run-section"><h3 class="run-h">🔎 Companies searched (${searchedCount}) &middot; ${withResults} with results</h3>
        ${searched.map((g) => {
          const items = g.companies.map((c) => companyHasResults(c) ? `<b>${escapeHtml(c)}</b>` : escapeHtml(c)).join(", ");
          return `<p class="searched-cat"><span class="searched-cat-name">${escapeHtml(g.category)}:</span> ${items}</p>`;
        }).join("")}
        <p class="small muted"><b>Bold</b> = has at least one role in the tracker; the rest were searched but returned no matching roles. These are the ATS-harvested employers; the agent may also web-search other firms.</p>
      </div>` : "";
  // Earlier runs: deduplicate by requestId (removes same-run multi-step duplicates),
  // drop empty entries, cap at 8.
  const seen = new Set(latest?.requestId ? [latest.requestId] : []);
  const earlier = ranked.slice(1)
    .filter(({ s }) => {
      if (s.requestId && seen.has(s.requestId)) return false;
      if (s.requestId) seen.add(s.requestId);
      return changePhrases(s).length || s.highlights || s.marketNotes;
    })
    .map(({ s }) => s)
    .slice(0, 8);
  const gmail = (data.gmailUpdates ?? []).slice().reverse().slice(0, 6);

  const phrases = latest ? changePhrases(latest) : [];
  const countsLine = phrases.length ? phrases.join(" · ") : "";
  const listHtml = (arr) => (Array.isArray(arr) && arr.length)
    ? `<ul class="run-list">${arr.map((x) => `<li>${highlightSkills(escapeHtml(String(x)))}</li>`).join("")}</ul>`
    : "";

  const changesSection = (Array.isArray(latest?.changes) && latest.changes.length)
    ? listHtml(latest.changes)
    : (phrases.length
        ? `<p class="run-changes">${escapeHtml(phrases.join(", ").replace(/^./, (c) => c.toUpperCase()))}.</p>`
        : `<p class="muted">No changes recorded this run.</p>`);

  const priorityNote = (typeof latest?.prioritiesShifted === "number" && latest.prioritiesShifted)
    ? ` · ${plural(latest.prioritiesShifted, "priority change", "priority changes")}` : "";

  const latestBlock = latest ? `
    <div class="run-card">
      <div class="run-head">
        <span class="run-when">${escapeHtml(latest.date || "")}</span>
        <span class="small">${escapeHtml(latest.agent || "")}${latest.requestId ? " · " + escapeHtml(latest.requestId) : ""}</span>
      </div>

      <div class="run-section"><h3 class="run-h">✏️ What changed</h3>
        ${changesSection}
        ${countsLine ? `<p class="small run-counts">${escapeHtml(countsLine)}${priorityNote}</p>` : ""}
      </div>
      ${searchedSection}

      <div class="run-section"><h3 class="run-h">🌍 Market overview</h3>
        ${latest.marketNotes ? `<p>${highlightSkills(escapeHtml(latest.marketNotes))}</p>` : `<p class="muted">—</p>`}
        ${latest.highlights ? `<p class="small"><b>Highlights:</b> ${highlightSkills(escapeHtml(latest.highlights))}</p>` : ""}
      </div>

      <div class="run-section"><h3 class="run-h">💡 Suggestions</h3>
        ${(Array.isArray(latest.suggestions) && latest.suggestions.length) ? listHtml(latest.suggestions) : `<p class="muted">None this run.</p>`}
      </div>
    </div>` : `<div class="empty">No run summary yet. Click “▶ Run Claude” or “▶ Run Codex”; each writes a holistic summary at the end of its run.</div>`;

  // Issues come from BOTH the agent's self-reported issues and a scan of the run
  // logs (the latter catches crashes that prevented any summary being written).
  const reportedIssues = (latest && Array.isArray(latest.issues) && latest.issues.length)
    ? `<div class="run-section"><h3 class="run-h">Agent-reported issues</h3>${listHtml(latest.issues)}</div>` : "";

  const olderRuns = earlier.map((r) => `
    <div class="req">
      <div class="req-type">${escapeHtml(r.date || "")}<span class="small">${escapeHtml(r.agent || "")}</span></div>
      <div class="req-body">${escapeHtml(changePhrases(r).join(", ") || "—")}<div class="small">${escapeHtml(r.marketNotes || r.highlights || "")}</div></div>
    </div>`).join("");

  content.innerHTML = `
    <div class="run-summary">
      <h2 class="section-h">Latest run</h2>
      ${latestBlock}

      <h2 class="section-h">⚠️ Issues &amp; deficiencies (from run logs)</h2>
      <div class="run-card"><div id="runHealth" class="muted">Checking the latest run logs…</div></div>
      ${reportedIssues}

      <h2 class="section-h">Recent email / status updates</h2>
      ${gmail.length ? `<div class="req-list">${gmail.map((g) => `
        <div class="req">
          <div class="req-type">${escapeHtml(g.date || "")}<span class="small">${escapeHtml(g.company || "")}</span></div>
          <div class="req-body"><b>${escapeHtml(g.result || "")}</b><div class="small">${escapeHtml(g.roleOrId || "")}${g.trackerUpdate ? " — " + escapeHtml(g.trackerUpdate) : ""}</div></div>
        </div>`).join("")}</div>` : `<div class="empty">No recent email updates recorded.</div>`}

      ${olderRuns ? `<h2 class="section-h">Previous runs</h2><div class="req-list">${olderRuns}</div>` : ""}
    </div>`;

  fillRunHealth();
}

// Fetch the server-side log scan and render failures/deficiencies for recent runs.
async function fillRunHealth() {
  const el = document.getElementById("runHealth");
  if (!el) return;
  try {
    const res = await fetch("/api/run-health");
    const { runs } = await res.json();
    if (!runs || !runs.length) { el.innerHTML = `<p class="muted">No run logs found yet.</p>`; return; }
    el.classList.remove("muted");
    el.innerHTML = runs.map((r) => {
      const clean = r.status === "COMPLETED" && !r.issues.length;
      const head = `${escapeHtml(formatRunDate(r.finishedAt))} · ${escapeHtml(r.agent || r.type)} · <span class="pill rq-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>${r.exitCode ? ` · exit ${escapeHtml(String(r.exitCode))}` : ""}${r.logPath ? ` · <a class="link-sm" href="/api/request-log?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener noreferrer">log</a>` : ""}`;
      const body = clean
        ? `<span class="ok">✓ clean — no failures or deficiencies detected</span>`
        : (r.issues.length
            ? `<ul class="run-list">${r.issues.map((i) => `<li>${escapeHtml(i.label)}${i.count > 1 ? ` <span class="muted">×${i.count}</span>` : ""}</li>`).join("")}</ul>`
            : `<span class="muted">—</span>`);
      return `<div class="health-row"><div class="small">${head}</div>${body}</div>`;
    }).join("");
  } catch {
    el.innerHTML = `<p class="muted">Could not load run health.</p>`;
  }
}

function render() {
  updateMeta();
  controls.style.display = isRolesTab() ? "" : "none";
  statusFilter.innerHTML = optionHtml(statusOptions, statusFilter.value, true);
  renderSummary();
  if (activeTab === "requests") renderRequests();
  else if (activeTab === "summary") renderRunSummary();
  else renderRoles();
}

// ---- editing ----

function updateField(target) {
  const index = Number(target.dataset.index);
  const field = target.dataset.field;
  if (Number.isNaN(index) || !["userApplied", "userRejected", "comments"].includes(field)) return;
  const role = data.roles[index];
  if (!role) return;
  const value = target.type === "checkbox" ? target.checked : target.value;
  if (role[field] === value) return;
  role[field] = value;
  role.lastUpdate = new Date().toISOString().slice(0, 10);
  if (field === "userApplied" && value && !role.appliedDate) role.appliedDate = role.lastUpdate;
  if (target.type === "checkbox") {
    render();          // status pill/locks depend on checkboxes
    scheduleSave(true); // checkbox = save immediately
  } else {
    scheduleSave();     // comment = debounced save (keeps text focus)
  }
}

function applyCandidate(candidate) {
  if (!candidate) return;
  const title = candidate.appTitle || "Job Search Dashboard";
  document.title = title;
  const h1 = document.querySelector("#appTitle");
  if (h1) h1.textContent = title;
  const phoneBtn = document.querySelector("#phoneCopy");
  if (phoneBtn) {
    if (candidate.phone) {
      const who = candidate.displayName ? `${candidate.displayName}: ` : "";
      phoneBtn.dataset.phone = candidate.phone;
      phoneBtn.textContent = `📋 ${who}${candidate.phone}`;
      phoneBtn.hidden = false;
    } else {
      phoneBtn.hidden = true;
    }
  }
}

async function load() {
  const bundle = await (await fetch("/api/data")).json();
  data = bundle.data;
  requests = bundle.requests;
  searchedCompaniesLive = bundle.searchedCompanies || null;
  applyCandidate(bundle.candidate);
  buildCompanyStats();
  render();
}
async function refreshRequests() {
  const res = await fetch("/api/requests");
  if (!res.ok) return;
  requests = await res.json();
  updateMeta();
  if (activeTab === "requests") renderRequests();
}

// Pull fresh role data when an agent (pipeline run) has changed the file, so the
// dashboard reflects archived/new roles without a manual reload. Guarded so it
// never clobbers an in-progress family edit.
function isEditingComment() {
  const el = document.activeElement;
  return el && el.classList && el.classList.contains("cmt");
}
async function reloadDataIfChanged() {
  if (saving || saveTimer !== null || isEditingComment()) return; // don't stomp unsaved edits
  const res = await fetch("/api/data");
  if (!res.ok) return;
  const bundle = await res.json();
  const serverUpdated = bundle.data?.meta?.updatedAt;
  if (!serverUpdated || serverUpdated === data?.meta?.updatedAt) return; // nothing new
  data = bundle.data;
  requests = bundle.requests;
  buildCompanyStats();
  render();
}
async function poll() {
  await refreshRequests();
  await reloadDataIfChanged();
}
const runModal = document.querySelector("#runModal");
const runTitle = document.querySelector("#runTitle");
const runNotes = document.querySelector("#runNotes");
const runMunichParis = document.querySelector("#runMunichParis");
const runStatus = document.querySelector("#runStatus");
const runModelSel = document.querySelector("#runModelSel");
const runEffortSel = document.querySelector("#runEffortSel");
const runSteps = {
  search: document.querySelector("#runStepSearch"),
  verify: document.querySelector("#runStepVerify"),
  email: document.querySelector("#runStepEmail"),
  review: document.querySelector("#runStepReview")
};
let runAgentPending = null;

async function openRunModal(agent) {
  runAgentPending = agent;
  runTitle.textContent = agent === "claude" ? "Run Claude" : "Run Codex";
  runNotes.value = "";
  runMunichParis.checked = false; // default: Switzerland only
  Object.values(runSteps).forEach((cb) => { cb.checked = true; }); // default: all steps on
  runModelSel.innerHTML = "";
  runEffortSel.innerHTML = "";
  runStatus.textContent = "Loading models…";
  runModal.classList.remove("hidden");
  try {
    const res = await fetch("/api/agent-config");
    const p = await res.json();
    if (!res.ok || !p.ok) throw new Error(p.error || res.status);
    const models = agent === "claude" ? p.options.claudeModels : p.options.codexModels;
    const efforts = agent === "claude" ? p.options.claudeEfforts : p.options.codexEfforts;
    fillSelect(runModelSel, models, p.config[agent].model);
    fillSelect(runEffortSel, efforts, p.config[agent].effort);
    const overridden = agent === "claude"
      ? (p.envOverride.claudeModel || p.envOverride.claudeEffort)
      : (p.envOverride.codexModel || p.envOverride.codexEffort);
    document.querySelector("#runModelEnv").classList.toggle("hidden", !overridden);
    runStatus.textContent = "";
  } catch (err) {
    runStatus.textContent = `Could not load models: ${err.message}`;
  }
  runNotes.focus();
}
function closeRunModal() { runModal.classList.add("hidden"); runAgentPending = null; }

async function startRun() {
  if (!runAgentPending) return;
  const agent = runAgentPending;
  runStatus.textContent = "Starting…";
  try {
    const res = await fetch("/api/run-agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent,
        notes: runNotes.value.trim(),
        includeMunichParis: runMunichParis.checked,
        model: runModelSel.value,
        effort: runEffortSel.value,
        phases: {
          search: runSteps.search.checked,
          verify: runSteps.verify.checked,
          email: runSteps.email.checked,
          review: runSteps.review.checked
        }
      })
    });
    const p = await res.json().catch(() => ({}));
    if (!res.ok) { runStatus.textContent = `Failed: ${p.error || res.status}`; return; }
    closeRunModal();
    await refreshRequests();
    switchTab("requests");
    window.setTimeout(refreshRequests, 1000);
  } catch (err) {
    runStatus.textContent = `Failed: ${err.message}`;
  }
}
async function runExistingRequest(id) {
  const res = await fetch("/api/run-request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  if (!res.ok) { const p = await res.json().catch(() => ({})); alert(`Run failed: ${p.error || res.status}`); return; }
  await refreshRequests();
}

function switchTab(tab) {
  activeTab = tab;
  summaryFilter = null;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  render();
}

// ---- events ----

content.addEventListener("input", (e) => updateField(e.target));
content.addEventListener("change", (e) => updateField(e.target));
content.addEventListener("click", (e) => {
  const exp = e.target.closest("[data-exp]");
  if (exp) { exp.closest(".row").classList.toggle("open"); return; }
  const run = e.target.closest("[data-run-request]");
  if (run) { runExistingRequest(run.dataset.runRequest); return; }
  const cl = e.target.closest("[data-coverletter]");
  if (cl) openCoverLetter(cl.dataset.coverletter, cl.dataset.mode || "letter");
});
summary.addEventListener("click", (e) => {
  const b = e.target.closest("[data-summary]");
  if (!b) return;
  const key = b.dataset.summary === "null" ? null : b.dataset.summary;
  summaryFilter = summaryFilter === key ? null : key;
  render();
});
textFilter.addEventListener("input", render);
statusFilter.addEventListener("change", () => { summaryFilter = null; render(); });
[priHigh, priMed, priLow, locSwiss].forEach((cb) => cb.addEventListener("change", render));
peerFilter.addEventListener("change", render);
sortControl.addEventListener("change", render);
runClaudeButton?.addEventListener("click", () => openRunModal("claude"));
runCodexButton?.addEventListener("click", () => openRunModal("codex"));
document.querySelector("#runClose")?.addEventListener("click", closeRunModal);
document.querySelector("#runStart")?.addEventListener("click", startRun);
runNotes?.addEventListener("keydown", (e) => { if (e.key === "Enter") startRun(); });

// ---- Cover letter ----
const clModal = document.querySelector("#clModal");
const clTitle = document.querySelector("#clTitle");
const clHint = document.querySelector("#clHint");
const clQuestions = document.querySelector("#clQuestions");
const clQuestionsSection = document.querySelector("#clQuestionsSection");
const clParagraphsSection = document.querySelector("#clParagraphsSection");
const clParagraphs = document.querySelector("#clParagraphs");
const clNotes = document.querySelector("#clNotes");
const clResult = document.querySelector("#clResult");
const clStatus = document.querySelector("#clStatus");
const clGenerate = document.querySelector("#clGenerate");
const clCopy = document.querySelector("#clCopy");
const clSave = document.querySelector("#clSave");
const clPdf = document.querySelector("#clPdf");
let clRole = null;
let clMode = "letter"; // "letter" | "questions"

function clAddQuestionRow(question = "", paragraphs = 1) {
  const row = document.createElement("div");
  row.className = "cl-qrow";
  row.innerHTML = `
    <input class="cl-q" type="text" placeholder="Question the application asks…" value="${escapeHtml(question)}">
    <input class="cl-qp" type="number" min="1" max="8" value="${paragraphs}" title="Paragraphs for this answer">
    <button class="tiny cl-qdel" title="Remove">✕</button>`;
  row.querySelector(".cl-qdel").addEventListener("click", () => row.remove());
  clQuestions.appendChild(row);
}

function openCoverLetter(roleId, mode = "letter") {
  clRole = (data.roles || []).find((r) => r.id === roleId);
  if (!clRole) return;
  clMode = mode === "questions" ? "questions" : "letter";
  const who = `${clRole.company}: ${clRole.role}`;
  if (clMode === "questions") {
    clTitle.textContent = `Form questions — ${who}`;
    clHint.textContent = "Add each question the application form asks (e.g. “your biggest achievement”, “why this company”) and how many paragraphs each answer should be.";
    clQuestionsSection.style.display = "";
    clParagraphsSection.style.display = "none";
    clQuestions.innerHTML = "";
    clAddQuestionRow();
  } else {
    clTitle.textContent = `Cover letter — ${who}`;
    clHint.textContent = "Generate a standard cover letter tailored to this role. Use the other button if the application asks specific form questions.";
    clQuestionsSection.style.display = "none";
    clParagraphsSection.style.display = "";
    clQuestions.innerHTML = "";
  }
  clNotes.value = "";
  clParagraphs.value = "3";
  clResult.value = "";
  clStatus.textContent = "";
  clCopy.disabled = true;
  clSave.disabled = true;
  clPdf.disabled = true;
  clModal.classList.remove("hidden");
}

function closeCoverLetter() { clModal.classList.add("hidden"); clRole = null; }

async function clGenerateNow() {
  if (!clRole) return;
  const questions = clMode === "questions"
    ? [...clQuestions.querySelectorAll(".cl-qrow")]
        .map((r) => ({ question: r.querySelector(".cl-q").value, paragraphs: Number(r.querySelector(".cl-qp").value) || 2 }))
        .filter((q) => q.question.trim())
    : [];
  if (clMode === "questions" && !questions.length) { clStatus.textContent = "Add at least one question."; return; }
  clGenerate.disabled = true;
  clResult.value = "";        // clear the previous result immediately
  clCopy.disabled = true;
  clSave.disabled = true;
  clPdf.disabled = true;
  clStatus.textContent = "Generating… (fetching the job description if needed; this can take ~30–60s)";
  try {
    const res = await fetch("/api/cover-letter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId: clRole.id, kind: clMode, questions, paragraphs: Number(clParagraphs.value) || 3, notes: clNotes.value })
    });
    const p = await res.json().catch(() => ({}));
    if (!res.ok) { clStatus.textContent = `Failed: ${p.error || res.status}`; return; }
    clResult.value = p.text || "";
    clStatus.textContent = p.jdSource === "live"
      ? "Done — tailored to the live job posting we fetched. Edit as needed."
      : p.jdSource === "harvest"
      ? "Done — tailored to the job description. Edit as needed."
      : "Done — no job description could be retrieved; used the role details we have. Edit as needed.";
    clCopy.disabled = false;
    clSave.disabled = false;
    clPdf.disabled = false;
  } catch (err) {
    clStatus.textContent = `Failed: ${err.message}`;
  } finally {
    clGenerate.disabled = false;
  }
}

async function clDownloadPdf() {
  if (!clRole || !clResult.value.trim()) return;
  clStatus.textContent = "Building PDF…";
  try {
    const res = await fetch("/api/cover-letter/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: clResult.value, company: clRole.company, role: clRole.role, kind: clMode })
    });
    if (!res.ok) { const p = await res.json().catch(() => ({})); clStatus.textContent = `PDF failed: ${p.error || res.status}`; return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${clMode === "questions" ? "form_answers" : "cover_letter"}_${(clRole.company || "role").replace(/[^a-z0-9]+/gi, "_")}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    clStatus.textContent = "PDF downloaded.";
  } catch (err) {
    clStatus.textContent = `PDF failed: ${err.message}`;
  }
}

document.querySelector("#clAddQ")?.addEventListener("click", () => clAddQuestionRow());
document.querySelector("#clClose")?.addEventListener("click", closeCoverLetter);
// Intentionally NOT closing on backdrop click — only the ✕ button closes the modal,
// so an accidental click outside doesn't discard the form.
clGenerate?.addEventListener("click", clGenerateNow);
clCopy?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(clResult.value); clStatus.textContent = "Copied to clipboard."; }
  catch { clResult.select(); document.execCommand("copy"); clStatus.textContent = "Copied."; }
});
clSave?.addEventListener("click", async () => {
  if (!clRole || !clResult.value.trim()) return;
  clStatus.textContent = "Saving…";
  try {
    const res = await fetch("/api/cover-letter/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: clResult.value, company: clRole.company, role: clRole.role, kind: clMode })
    });
    const p = await res.json().catch(() => ({}));
    clStatus.textContent = res.ok ? `Saved to ${p.path}` : `Save failed: ${p.error || res.status}`;
  } catch (err) {
    clStatus.textContent = `Save failed: ${err.message}`;
  }
});
clPdf?.addEventListener("click", clDownloadPdf);

const phoneButton = document.querySelector("#phoneCopy");
phoneButton?.addEventListener("click", async () => {
  const phone = phoneButton.dataset.phone;
  try {
    await navigator.clipboard.writeText(phone);
  } catch {
    const tmp = document.createElement("textarea");
    tmp.value = phone; document.body.appendChild(tmp); tmp.select();
    document.execCommand("copy"); tmp.remove();
  }
  const original = phoneButton.textContent;
  phoneButton.textContent = "✓ Copied " + phone;
  phoneButton.classList.add("copied");
  window.setTimeout(() => { phoneButton.textContent = original; phoneButton.classList.remove("copied"); }, 1500);
});
// ---- Model / thinking-level selectors (shared by the run popup) ----
const effortLabels = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max (highest)" };

function fillSelect(select, options, selected) {
  select.innerHTML = options.map((o) => {
    const value = typeof o === "string" ? o : o.value;
    const label = typeof o === "string" ? (effortLabels[o] || o) : o.label;
    const sel = value === selected ? " selected" : "";
    return `<option value="${escapeHtml(value)}"${sel}>${escapeHtml(label)}</option>`;
  }).join("");
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.dataset.tab)));

window.addEventListener("beforeunload", (e) => {
  if (!saving && !pendingSave && saveTimer === null) return;
  e.preventDefault();
  e.returnValue = "";
});
window.setInterval(poll, 5000);

load().catch((error) => {
  content.innerHTML = `<div class="empty">Dashboard failed to load: ${escapeHtml(error.message)}</div>`;
});
