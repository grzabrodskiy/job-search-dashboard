import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const publicDir = resolve(__dirname, "public");
const dataPath = resolve(root, "tracking/search_results.json");
const requestsPath = resolve(root, "tracking/dashboard_requests.json");
const reportPath = resolve(root, "reports/search_results.md");
const runLogDir = resolve(root, "reports/agent_runs");
const atsSourcesPath = resolve(root, "dashboard/scripts/ats_sources.json");
const candidateConfigPath = resolve(root, "config/candidate.json");
const candidateExamplePath = resolve(root, "config/candidate.example.json");
const port = Number(process.env.PORT || 3000);
const codexCli = process.env.CODEX_CLI || "codex";
const claudeCli = process.env.CLAUDE_CLI || "claude";
const agentConfigPath = resolve(root, "tracking/agent_config.json");

// Which model + thinking (reasoning) effort each agent runs at. Edited live from the
// dashboard's "Models" screen and stored in tracking/agent_config.json, so a change
// takes effect on the next run without restarting the server. Env vars still override
// (a power-user escape hatch); an unknown stored choice falls back to the default.
const CLAUDE_MODELS = [
  { value: "claude-opus-5", label: "Opus 5 (most capable)" },
  { value: "claude-fable-5", label: "Fable 5" },
  { value: "claude-sonnet-5", label: "Sonnet 5" },
  { value: "claude-opus-4-8", label: "Opus 4.8 (previous gen)" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (fast)" }
];
const CODEX_MODELS = [
  { value: "gpt-5.6-sol", label: "GPT-5.6" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "", label: "Codex default (config.toml)" }
];
// Highest thinking is last in each list: Claude "max", Codex "xhigh".
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];
const AGENT_DEFAULTS = {
  claude: { model: "claude-fable-5", effort: "max" },
  codex: { model: "gpt-5.6-sol", effort: "xhigh" }
};

function pickFromModels(list, value, fallback) {
  return list.some((m) => m.value === value) ? value : fallback;
}
function pickFromEfforts(list, value, fallback) {
  return list.includes(value) ? value : fallback;
}
// Validate a stored/submitted config against the allowed lists (an unknown model or
// effort falls back to the default). This is exactly what gets written to disk — it
// never mixes in env vars, so saving can't corrupt the family's stored preference.
function sanitizeAgentConfig(stored) {
  const s = stored || {};
  return {
    claude: {
      model: pickFromModels(CLAUDE_MODELS, (s.claude || {}).model, AGENT_DEFAULTS.claude.model),
      effort: pickFromEfforts(CLAUDE_EFFORTS, (s.claude || {}).effort, AGENT_DEFAULTS.claude.effort)
    },
    codex: {
      model: pickFromModels(CODEX_MODELS, (s.codex || {}).model, AGENT_DEFAULTS.codex.model),
      effort: pickFromEfforts(CODEX_EFFORTS, (s.codex || {}).effort, AGENT_DEFAULTS.codex.effort)
    }
  };
}
// Effective config for an actual run: the stored choice, with env vars overriding it
// (a power-user escape hatch — CLAUDE_MODEL / CLAUDE_EFFORT / CODEX_MODEL / CODEX_EFFORT
// force a value without touching the file). Applied at run/display time only.
function applyEnvOverride(config) {
  const claude = { ...config.claude };
  const codex = { ...config.codex };
  if (process.env.CLAUDE_MODEL) claude.model = process.env.CLAUDE_MODEL;
  if (process.env.CLAUDE_EFFORT) claude.effort = process.env.CLAUDE_EFFORT;
  if (process.env.CODEX_MODEL) codex.model = process.env.CODEX_MODEL;
  if (process.env.CODEX_EFFORT) codex.effort = process.env.CODEX_EFFORT;
  return { claude, codex };
}
async function loadAgentConfig() {
  return applyEnvOverride(sanitizeAgentConfig(await readJson(agentConfigPath, {})));
}

// Five base statuses. The agent owns the base `status`; the family ticks
// userApplied / userRejected; roles auto-archive after 30 idle days.
const statusLabels = new Map([
  ["NEW", "New"],
  ["OPEN", "Open"],
  ["APPLIED", "Applied"],
  ["DECLINED", "Declined"],
  ["ARCHIVED", "Archived"]
]);
const linkStatusLabels = new Map([
  ["VERIFIED", "Apply verified"],
  ["DIRECT", "Direct posting"],
  ["SEARCH", "Search page"],
  ["UNVERIFIED", "Unverified"],
  ["STALE", "Stale / filled"]
]);
const ARCHIVE_AGE_DAYS = 30;

// Age is measured from when the role was added (createdDate), NOT lastUpdate —
// so a family comment/checkbox edit can't reset the 30-day auto-archive clock or
// un-archive an already-aged-out role.
function ageDays(role) {
  const ref = role.createdDate || role.updatedAt;
  if (!ref) return 0;
  const then = new Date(ref).getTime();
  if (Number.isNaN(then)) return 0;
  return (Date.now() - then) / 86400000;
}

// Display status, derived from agent base + family checkboxes + age.
function computeStatus(role) {
  if (role.userRejected || role.status === "DECLINED") return "DECLINED";
  if (role.userApplied || role.status === "APPLIED") return "APPLIED";
  if (role.status === "ARCHIVED" || ageDays(role) >= ARCHIVE_AGE_DAYS) return "ARCHIVED";
  return role.status === "NEW" ? "NEW" : "OPEN";
}

const SWISS_HINTS = ["switzerland", "swiss", "zurich", "zürich", "zug", "geneva", "genève", "geneve", "basel", "bern", "lausanne", "gland", "rüschlikon", "ruschlikon", "lugano", "winterthur", "(ch", " ch)", ", ch"];
function isSwiss(location = "") {
  const l = String(location).toLowerCase();
  return SWISS_HINTS.some((hint) => l.includes(hint));
}

const priorityWeight = new Map([["HIGH", 3], ["MEDIUM", 2], ["LOW", 1]]);
// Best-jobs view shows only roles still worth pursuing.
const activeStatuses = new Set(["NEW", "OPEN"]);

function roleScore(role) {
  return (priorityWeight.get(role.priority) ?? 1)
    + (computeStatus(role) === "NEW" ? 1 : 0)
    + (isSwiss(role.location) ? 2 : 0)
    + (role.peerReviewed ? 1 : 0);
}

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
]);

function escapeCell(value = "") {
  return String(value)
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}

function linkCell(label, url) {
  if (!url) return "";
  return `[${escapeCell(label || "Link")}](${url})`;
}

function statusLabel(value) {
  return statusLabels.get(value) ?? value ?? "";
}

function statusCell(role) {
  const label = statusLabel(computeStatus(role));
  const note = String(role.statusNote ?? "").trim();
  if (!note) return label;
  const upperNote = note.toUpperCase();
  if (upperNote === label.toUpperCase() || upperNote.startsWith(`${label.toUpperCase()} -`)) return note;
  return `${label} - ${note}`;
}

function markdownRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function dateOnly(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function currentDateZurich() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temp, path);
}

// Candidate profile + search brief. All PII lives in config/candidate.json (gitignored);
// a fresh clone with no real file falls back to config/candidate.example.json so the app
// still boots. Cached for the process lifetime (edit the file, restart to pick up changes).
let _candidate = null;
async function loadCandidate() {
  if (_candidate) return _candidate;
  _candidate = (await readJson(candidateConfigPath, null)) || (await readJson(candidateExamplePath, {}));
  return _candidate;
}

function isApplication(role) {
  return computeStatus(role) === "APPLIED";
}

function bestJobsSorted(roles) {
  return roles
    .filter((role) => activeStatuses.has(computeStatus(role)))
    .sort((a, b) => roleScore(b) - roleScore(a) || String(b.lastUpdate || "").localeCompare(String(a.lastUpdate || "")));
}

function roleMarkdownRow(role) {
  return markdownRow([
    escapeCell(role.id),
    escapeCell(role.lastUpdate || role.createdDate),
    escapeCell(role.company),
    escapeCell(role.role),
    escapeCell(role.internalId),
    escapeCell(role.location),
    linkCell("Link", role.link),
    escapeCell(statusCell(role)),
    role.peerReviewed ? "Yes" : "No",
    escapeCell(role.priority),
    escapeCell(linkStatusLabels.get(role.linkStatus) ?? role.linkStatus),
    escapeCell(role.salaryRange),
    escapeCell(role.fitRiskSummary || role.nextAction),
    escapeCell(role.comments)
  ]);
}

function generateMarkdown(data) {
  const updated = data.meta?.updatedLabel || currentDateZurich();
  const roles = data.roles ?? [];
  const header = "| ID | Updated | Company | Role | Internal ID | Location | Link | Status | Peer reviewed | Priority | Link Status | Salary Range | Fit / Next | Comments |\n|----|---------|---------|------|-------------|----------|------|--------|---------------|----------|-------------|--------------|------------|----------|";
  const emptyRow = "| | | | | | | | | | | | | | |";

  const best = bestJobsSorted(roles).slice(0, 20).map(roleMarkdownRow);
  const apps = roles.filter(isApplication)
    .sort((a, b) => String(b.appliedDate || b.lastUpdate || "").localeCompare(String(a.appliedDate || a.lastUpdate || "")))
    .map(roleMarkdownRow);
  const all = [...roles]
    .sort((a, b) => String(b.lastUpdate || "").localeCompare(String(a.lastUpdate || "")))
    .map(roleMarkdownRow);

  const gmailRows = (data.gmailUpdates ?? []).map((row) =>
    markdownRow([
      escapeCell(row.date),
      escapeCell(row.company),
      escapeCell(row.roleOrId),
      escapeCell(row.result),
      escapeCell(row.trackerUpdate)
    ])
  );

  const runs = (data.runSummaries ?? []).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const latest = runs[0];
  const latestRunMd = latest
    ? `- Date: ${escapeCell(latest.date)}${latest.agent ? ` (${escapeCell(latest.agent)})` : ""}
- New roles: ${latest.newRoles ?? "—"}; Archived: ${latest.archived ?? "—"}; Removed: ${latest.removed ?? "—"}
- Emails — applications: ${latest.emails?.applications ?? "—"}; replies: ${latest.emails?.replies ?? "—"}; rejections: ${latest.emails?.rejections ?? "—"}; interviews: ${latest.emails?.interviews ?? "—"}
- Highlights: ${escapeCell(latest.highlights || "—")}
- Market state: ${escapeCell(latest.marketNotes || "—")}`
    : "_No run summary recorded yet._";

  return `# Consolidated Search Results

Last updated: ${updated}
Canonical source: \`tracking/search_results.json\`. This file is generated from the JSON — do not hand-edit. Each role is one row with a permanent ID (\`R-####\`) and a single shared status.

## Latest Run Summary

${latestRunMd}

## Status Model

Five statuses: \`NEW\` (recently added; stays NEW for 7 days from createdDate, then demoted to OPEN on the next scheduled run), \`OPEN\` (active candidate), \`APPLIED\` (family ticked Applied or recruiter evidence), \`DECLINED\` (rejected by the candidate/family or by the employer), \`ARCHIVED\` (closed, or 30+ days idle). The agent sets the base \`status\`; the family ticks \`userApplied\`/\`userRejected\`; the display status is derived. \`Link Status\`: VERIFIED, DIRECT, SEARCH, UNVERIFIED, STALE. \`Peer reviewed\` means the other model checked it.

## Best Jobs (ranked)

Active roles (NEW/OPEN) by priority + Swiss location + peer-review.

${header}
${best.length ? best.join("\n") : emptyRow}

## Applications (applied / in pipeline)

${header}
${apps.length ? apps.join("\n") : emptyRow}

## All Roles

Most recently updated first.

${header}
${all.length ? all.join("\n") : emptyRow}

## Latest Gmail Status Updates

| Date | Company | Role / ID | Result | Tracker Update |
|------|---------|-----------|--------|----------------|
${gmailRows.length ? gmailRows.join("\n") : "| | | | | |"}
`;
}

async function loadBundle() {
  const data = await readJson(dataPath, {
    meta: { version: 2, updatedAt: new Date().toISOString(), updatedBy: "dashboard-server", nextId: 1 },
    statusOptions: [],
    priorityOptions: [],
    linkStatusOptions: [],
    requestTypes: [],
    gmailUpdates: [],
    runSummaries: [],
    roles: []
  });
  const requests = await readJson(requestsPath, {
    meta: { version: 1, updatedAt: new Date().toISOString(), updatedBy: "dashboard-server" },
    requests: []
  });
  const c = await loadCandidate();
  const candidate = { appTitle: c.appTitle || "Job Search Dashboard", displayName: c.displayName || "", phone: c.phone || "" };
  // Current ATS source list (grouped by industry) so the "Companies searched" view can
  // render even for runs that predate the per-run snapshot.
  const searchedCompanies = await searchedCompaniesByCategory();
  return { data, requests, candidate, searchedCompanies };
}

async function saveData(data) {
  data.meta = {
    ...(data.meta ?? {}),
    version: data.meta?.version ?? 2,
    updatedAt: new Date().toISOString(),
    updatedBy: "dashboard"
  };
  await writeJsonAtomic(dataPath, data);
  await writeFile(reportPath, generateMarkdown(data), "utf8");
}

function mergeDashboardEdits(currentData, incomingData) {
  const merged = JSON.parse(JSON.stringify(currentData ?? {}));
  const now = new Date().toISOString();
  const today = dateOnly(now);
  // The family only edits the two checkboxes and the comment; the agent owns base status.
  const editableFields = ["userApplied", "userRejected", "comments"];

  const currentRows = Array.isArray(merged.roles) ? merged.roles : [];
  const incomingRows = Array.isArray(incomingData?.roles) ? incomingData.roles : [];
  const incomingById = new Map(incomingRows.map((row) => [row.id, row]));

  merged.roles = currentRows.map((row) => {
    const incoming = incomingById.get(row.id);
    if (!incoming) return row;

    let changed = false;
    const next = { ...row };
    for (const field of editableFields) {
      if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
      if (incoming[field] !== row[field]) changed = true;
      next[field] = incoming[field];
    }

    if (!changed) return row;
    // Stamp an applied date the first time the family marks the role applied.
    if (next.userApplied && !next.appliedDate) next.appliedDate = today;
    return { ...next, lastUpdate: today, updatedAt: now };
  });

  return merged;
}

// The employers whose ATS feeds the harvest pulls each run, grouped by industry,
// for the "companies searched" list in the latest-run view. Finance categories first.
const SEARCH_CATEGORY_ORDER = ["Banks", "Private Banks", "Hedge Funds", "Asset Managers", "Commodity Trading", "Insurance", "Crypto / Fintech", "Tech / AI"];
async function searchedCompaniesByCategory() {
  const cfg = await readJson(atsSourcesPath, { sources: [] });
  const groups = new Map();
  for (const s of cfg.sources ?? []) {
    if (!s.company) continue;
    const cat = s.category || "Other";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(s.company);
  }
  const rank = (cat) => { const i = SEARCH_CATEGORY_ORDER.indexOf(cat); return i === -1 ? SEARCH_CATEGORY_ORDER.length : i; };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, companies]) => ({ category, companies }));
}

// Which of the four optional run steps are enabled (default all on).
function normalizePhases(p) {
  const x = p || {};
  return {
    search: x.search !== false,
    verify: x.verify !== false,
    email: x.email !== false,
    review: x.review !== false
  };
}

async function addRequest(payload) {
  const requests = await readJson(requestsPath, { meta: { version: 1 }, requests: [] });
  const now = new Date().toISOString();
  const request = {
    id: `REQ-${now.replace(/[-:.TZ]/g, "").slice(0, 17)}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: now,
    status: "OPEN",
    type: payload.type,
    assignedTo: payload.assignedTo ?? "",
    title: payload.title ?? "",
    notes: payload.notes ?? "",
    createdBy: "dashboard",
    parentId: payload.parentId ?? "",
    step: payload.step ?? null,
    includeMunichParis: payload.includeMunichParis === true,
    phases: normalizePhases(payload.phases)
  };
  requests.requests = [request, ...(requests.requests ?? [])];
  requests.meta = { ...(requests.meta ?? {}), updatedAt: now, updatedBy: "dashboard" };
  await writeJsonAtomic(requestsPath, requests);
  return request;
}

async function updateRequest(requestId, patch) {
  const requests = await readJson(requestsPath, { meta: { version: 1 }, requests: [] });
  let updated = null;
  requests.requests = (requests.requests ?? []).map((request) => {
    if (request.id !== requestId) return request;
    updated = { ...request, ...patch };
    return updated;
  });
  requests.meta = { ...(requests.meta ?? {}), updatedAt: new Date().toISOString(), updatedBy: "dashboard-runner" };
  await writeJsonAtomic(requestsPath, requests);
  return updated;
}

function agentForRequest(type) {
  if (type === "CLAUDE_FULL_RUN") return "claude";
  if (type === "CODEX_FULL_RUN") return "codex";
  return "";
}

function promptForRequest(request, agent, candidate) {
  const notes = request.notes?.trim() || "(none)";
  const brief = candidate.searchBrief || {};
  const includeMunichParis = request.includeMunichParis === true;
  const locationScope = includeMunichParis
    ? "SWITZERLAND (primary: Zurich > Zug > Geneva > Basel > Bern/Lausanne/Lugano) PLUS Munich and Paris as secondary in-scope locations. Verify the real city on the posting; never infer it."
    : "SWITZERLAND ONLY (Zurich > Zug > Geneva > Basel > Bern/Lausanne/Lugano). Do NOT log Munich, Paris, or ANY other non-Swiss location on this run — skip them entirely, even a strong fit. Verify the real city on the posting; never infer it.";
  const phases = request.phases || {};
  const doSearch = phases.search !== false;
  const doVerify = phases.verify !== false;
  const doEmail = phases.email !== false;
  const doReview = phases.review !== false;

  const intro = "Run a job-search maintenance pass. The full rubric, source list, and field definitions live in workflows/search_session.md and prompts/job_search_prompt.md — read them; this is a summary, not a replacement.";
  const scopeLine = `LOCATION SCOPE FOR THIS RUN (hard filter — overrides any location wording elsewhere in this prompt): ${locationScope}`;
  const enabledSteps = [
    doSearch && "SEARCH for new roles",
    doVerify && "RE-VERIFY the active roles (rotating slice)",
    doEmail && "CHECK EMAIL for recruiter replies and update statuses",
    doReview && "SELF-REVIEW your new finds"
  ].filter(Boolean);
  const stepsBanner = `STEPS ENABLED FOR THIS RUN — do ONLY these and skip anything not listed (the family unchecked the rest in the run popup): ${enabledSteps.length ? enabledSteps.join("; ") : "none of the optional steps"}. You must ALWAYS finish with the run-summary step regardless.`;

  const discoveryBlock = [
    "DISCOVERY (find NEW leads for the dashboard). Start from the ATS harvest at tracking/ats_candidates.json: a pre-fetched, NON-bot-blocked list of HUNDREDS of live postings pulled straight from employer ATS JSON APIs. Each candidate has company, role, location, internalId, direct link, AND a `description` field with the FULL job-description text (and sometimes `comp`). USE THE description FIELD to score fit, detect the required language, extract pros/cons and the salary, and write fitRiskSummary — you do NOT need to web-fetch the posting when the description is present (this avoids 403s and saves context). If the harvest is missing or stale (meta.fetchedAt older than today), run `node dashboard/scripts/fetch_ats.mjs` first. THIS HARVEST IS YOUR PRIMARY SOURCE — curate it thoroughly: apply the strict fit rubric, dedupe against roles[], and log the genuine fits. Only AFTER working the harvest, use a SMALL number of targeted web searches to fill specific gaps. NOTE: WebFetch is frequently 403-blocked by ATS/career sites — when a page is blocked, prefer the ATS JSON API (extend dashboard/scripts/ats_sources.json with the employer's slug and re-run the harvester) rather than giving up on the role.",
    "",
    "CONTEXT BUDGET (hard rule — a previous run CRASHED by running ~69 web searches until it ran out of context). Because the harvest already contains hundreds of real candidates, ad-hoc web searching must be SPARING: aim for at most ~15 web searches this run, and NEVER fetch/paste full page bodies — extract only the few fields you need (title, location, id, link) and discard the rest. If you notice your context growing large, STOP searching immediately and finalize: write what you have to tracking/search_results.json and end cleanly. A COMPLETED run with fewer roles is far better than a crash that loses everything.",
    "",
    "TWO-TIER LOGGING — DO NOT DISCARD A REAL FIND JUST BECAUSE YOU COULD NOT FETCH ITS PAGE. The bar to LOG a candidate (status NEW) is lower than the bar to RECOMMEND it. If a role is a genuine fit but its apply page is bot-blocked/unfetchable, still log it as NEW with linkStatus UNVERIFIED and say so in statusNote (e.g. 'real fit from ATS harvest / search; apply page 403 to fetch — needs human/Codex verification'). Only roles whose direct employer/ATS page you actually confirmed live get linkStatus VERIFIED or DIRECT. Reserve OMIT for genuine non-fits, not for verification gaps — surfacing an unverified real fit beats showing the family nothing."
  ].join("\n");

  const verifyBlock = "RE-VERIFICATION (rotating slice, NOT all roles every run). Re-verify and re-review the active (NEW/OPEN) roles that are (a) stalest — lastUpdate more than 7 days ago — or (b) carry a family comment. For each: confirm the posting still exists, re-check fit/level/location/language/sponsorship, update linkStatus/fitRiskSummary, set ARCHIVED for postings that are gone, and answer any family comment in statusNote. You need not re-fetch every single role if it was verified in the last few days — spend the saved budget on discovery. THEN demote prior NEW roles to OPEN — but ONLY if their createdDate is more than 7 days ago. Roles added within the last 7 days should stay as NEW; they are still 'fresh finds' and the family needs time to review them. (NEW means 'recently added'; OPEN means 'active but no longer new'.)";

  const commonRules = [
    "FAMILY COMMENTS: treat the comments field on existing roles as standing guidance (e.g. 'Google usually rejects me' => deprioritize, but a clearly different team is still in scope); apply them this pass and distill durable ones into memory/agent_memory.md or memory/improvements.md.",
    "DEDUPE: cross-check every candidate against roles[] by company+role+internalId; never re-add something already present, applied to, or rejected for the same role — update the existing row instead.",
    `RUBRIC (summary; full version in workflows/search_session.md): Level ${brief.levelFilter || "Senior/Lead/Staff/Principal/EM/VP"}. Developer-first hands-on engineering, OR applied LLM/agentic product/platform work. EXCLUDE DevOps/SRE/infra/MLOps/model-serving (K8s ops, Terraform/Ansible IaC, observability/on-call, vLLM/Triton/KServe serving). LANGUAGE: the candidate is strong in ${brief.strongLanguages || "the languages in config/candidate.json"}; exclude/downgrade roles demanding ${brief.weakLanguages || "a non-core language"} at hard senior depth with no ramp-up. LOCATION: obey the LOCATION SCOPE FOR THIS RUN stated near the top of this prompt exactly — do not deviate from it. SPONSORSHIP: ${brief.sponsorship || "confirm the employer sponsors if a permit is needed"}.`,
    `CURRENT EMPLOYER (${candidate.currentEmployer || "the candidate's current employer"}): ${candidate.currentEmployerExclusion || "Roles at the current employer in scope locations are fine as standard external applications; do not use its internal mobility platform and do not surface the candidate's own current role or team."}`,
    "For each new/updated role set company, role, internalId, location, link, status, statusNote, priority, linkStatus (VERIFIED/DIRECT/SEARCH/UNVERIFIED/STALE), salaryRange, pros, cons, fitRiskSummary, nextAction. ALWAYS provide salaryRange — a concrete comp range in local currency (CHF/EUR); if the posting does not state one, give a market estimate for the role+level+location and append ' (est.)'. pros = ARRAY of 3-6 short concrete strengths/match points for the candidate; cons = ARRAY of gaps/risks/concerns (e.g. 'C++ primary', 'startup — sponsorship unclear', 'under-levels a VP'). Keep fitRiskSummary as a one-line headline verdict. New finds get status NEW with id from meta.nextId (increment it)."
  ].join("\n");

  const emailTask = "EMAIL STATUS UPDATE: Check the configured Gmail/email tooling if available and update roles from recruiter replies, mapping each reply to the correct role by its permanent R-#### id and exact internalId/date. On confirmed application receipt/interview/offer set base status APPLIED; on confirmed employer rejection set base status DECLINED (statusNote: rejected by employer). Set these ONLY from real evidence; they lock the family's Applied/Reject checkbox. Never set base DECLINED for a family 'not interested' decision. If Gmail access is unavailable, note that in the log and do not guess.";
  const selfReview = "SELF-REVIEW your OWN new finds critically — this is a SOLO run, there is no second model, so be your own harshest critic: try to DISQUALIFY weak fits and dead links, re-check level/location/skills/sponsorship and link liveness, and set status DECLINED or ARCHIVED with a clear reason where warranted. Do NOT set peerReviewed=true (that flag means the OTHER model reviewed it; a solo run cannot earn it).";
  const runSummary = "FINALLY, push ONE run-summary object to the END of the runSummaries[] array in tracking/search_results.json (use push / spread [...existing, newEntry] — do NOT prepend or insert at the start) describing THIS run HOLISTICALLY (the dashboard renders it as four sections: What changed / Issues / Market / Suggestions): {date (YYYY-MM-DD), agent, requestId, newRoles, archived, removed, prioritiesShifted (count of roles whose priority you changed this run), emails:{applications,replies,rejections,interviews}, changes (ARRAY of short human-readable bullets of what MATERIALLY changed — e.g. 'Added 4 Zurich roles (Google, Mistral, On)', 'Raised QRT R-0042 to HIGH', 'Archived 2 filled CFM roles', 'Declined Citi — employer rejection'), issues (ARRAY of problems hit this run — e.g. 'Could not read UBS jobs: Brassring bot-blocked', 'Swiss Re behind Cloudflare'; [] if none), marketNotes (short text: overall Swiss/target-market state — demand, who is hiring, gaps), highlights (short text: the strongest new roles/actions), suggestions (ARRAY of concrete ideas to improve the PROCESS or the SEARCH — e.g. \"Add employer X's ATS slug to ats_sources.json\", 'Loosen the language filter for adjacent-language roles', 'Set a job alert for a key employer to the monitored inbox')}. Use real counts; use 0 or [] when nothing applies; keep each array concise (<=6 items).";

  const taskParts = [intro, "", scopeLine, "", stepsBanner, ""];
  if (doSearch) taskParts.push(discoveryBlock, "");
  if (doVerify) taskParts.push(verifyBlock, "");
  if (doSearch || doVerify) taskParts.push(commonRules, "");
  if (doEmail) taskParts.push(emailTask, "");
  if (doReview) taskParts.push(selfReview, "");
  taskParts.push(runSummary);
  const soloRun = taskParts.join("\n");
  const typeInstructions = new Map([
    ["CLAUDE_FULL_RUN", soloRun],
    ["CODEX_FULL_RUN", soloRun]
  ]);

  const hasNotes = notes && notes !== "(none)";
  const priorityBlock = hasNotes
    ? `========================================================
PRIORITY INSTRUCTION FROM THE FAMILY FOR THIS RUN
========================================================
${notes}

This is the family's explicit instruction for THIS run and takes precedence
over the default scope below wherever they conflict. If it names specific
companies, locations, or role types, NARROW this run to focus on them first
(you may still do the standard re-verify/dedupe bookkeeping). Begin your final
summary by stating how you addressed this instruction.
========================================================

`
    : "";

  return `You are ${agent} running from the local ${candidate.fullName || "candidate's"} job-search dashboard.

Request ID: ${request.id}
Request type: ${request.type}
Title: ${request.title}

${priorityBlock}Task:
${typeInstructions.get(request.type) ?? "Read the dashboard request and handle it conservatively."}

Required workflow:
1. Work in this repository: ${root}
2. Read AGENTS.md, CLAUDE.md if relevant, workflows/search_session.md, prompts/job_search_prompt.md, tracking/search_results.json, and tracking/dashboard_requests.json before changing anything.
3. Data model: tracking/search_results.json is the SINGLE source of truth. One roles[] array; each role has a permanent id (R-####, from meta.nextId — increment it for new roles). The agent sets the base status: NEW (added this search), OPEN (active), ARCHIVED (dead/30+ idle), and — ONLY from confirmed email evidence — APPLIED (application seen) or DECLINED (employer rejection). Base APPLIED/DECLINED lock the family's Applied/Reject checkbox, so never set them without evidence and never use DECLINED for a family decision. The family owns userApplied, userRejected, and comments (do NOT set or overwrite these; use comments as guidance). Re-verify active (NEW/OPEN) roles on a ROTATING SLICE — roles that are stalest (lastUpdate > 7 days) or carry a family comment. Roles verified in the last few days can be trusted; spend the saved budget on discovery. The displayed status is derived: userRejected or base DECLINED => Declined; userApplied or base APPLIED => Applied; base ARCHIVED or 30+ idle days => Archived; else NEW/OPEN. Put reasons/details in statusNote. Do NOT recreate the old results/applications split, manual* fields, or tracking/leads.md / tracking/applications.md (retired).
4. Preserve family decisions: never overwrite userApplied, userRejected, or comments. Do not flip an OPEN role they have engaged with to ARCHIVED without reason.
5. Update tracking/search_results.json only; reports/search_results.md is generated and must not be hand-edited.
6. Add a short note to tracking/dashboard_requests.json for this request if there is important context. The dashboard runner marks process completion from the exit code.
7. Do not apply to jobs, send emails, or contact recruiters unless the human explicitly asked for that exact action.

Be thorough and prioritize good match quality over quantity.`;
}

async function runSpecForRequest(request) {
  const agent = agentForRequest(request.type);
  const cfg = await loadAgentConfig();
  const candidate = await loadCandidate();
  if (agent === "codex") {
    return {
      agent,
      command: codexCli,
      model: cfg.codex.model,
      effort: cfg.codex.effort,
      args: [
        "--search",
        "--ask-for-approval",
        "never",
        "exec",
        ...(cfg.codex.model ? ["--model", cfg.codex.model] : []),
        "-c",
        `model_reasoning_effort=${cfg.codex.effort}`,
        "--cd",
        root,
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        promptForRequest(request, agent, candidate)
      ]
    };
  }
  if (agent === "claude") {
    return {
      agent,
      command: claudeCli,
      model: cfg.claude.model,
      effort: cfg.claude.effort,
      args: [
        "-p",
        "--model",
        cfg.claude.model,
        "--effort",
        cfg.claude.effort,
        "--permission-mode",
        "acceptEdits",
        promptForRequest(request, agent, candidate)
      ]
    };
  }
  return null;
}

async function startRequestProcess(request) {
  const spec = await runSpecForRequest(request);
  if (!spec) return { running: request, completion: Promise.resolve(request) };

  await mkdir(runLogDir, { recursive: true });
  const logName = `${request.id}-${spec.agent}.log`;
  const logPath = resolve(runLogDir, logName);
  const relativeLogPath = `reports/agent_runs/${logName}`;
  const startedAt = new Date().toISOString();

  const running = await updateRequest(request.id, {
    status: "RUNNING",
    assignedTo: spec.agent,
    startedAt,
    logPath: relativeLogPath,
    model: spec.model || "",
    effort: spec.effort || "",
    finishedAt: "",
    exitCode: null,
    signal: "",
    error: ""
  });

  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`Agent run started: ${startedAt}\n`);
  log.write(`Request: ${request.id} ${request.type}\n`);
  log.write(`Command: ${spec.command} ${spec.args.slice(0, -1).join(" ")} [prompt]\n\n`);

  const child = spawn(spec.command, spec.args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  const completion = new Promise((resolveCompletion) => {
    let settled = false;

    child.on("error", async (error) => {
      if (settled) return;
      settled = true;
      const finishedAt = new Date().toISOString();
      log.write(`\nAgent run failed to start: ${error.message}\n`);
      log.end();
      const failed = await updateRequest(request.id, {
        status: "FAILED",
        finishedAt,
        error: error.message
      });
      resolveCompletion(failed ?? request);
    });

    child.on("close", async (code, signal) => {
      if (settled) return;
      settled = true;
      const finishedAt = new Date().toISOString();
      log.write(`\nAgent run finished: ${finishedAt}\n`);
      log.write(`Exit code: ${code}; signal: ${signal ?? ""}\n`);
      log.end();
      const finished = await updateRequest(request.id, {
        status: code === 0 ? "COMPLETED" : "FAILED",
        finishedAt,
        exitCode: code,
        signal: signal ?? ""
      });
      resolveCompletion(finished ?? request);
    });
  });

  return { running: running ?? request, completion };
}

async function runRequest(request) {
  const { running } = await startRequestProcess(request);
  return running;
}

async function runRequestAndWait(request) {
  const { completion } = await startRequestProcess(request);
  return completion;
}

// Step 0 of every pipeline run: refresh the ATS candidate harvest. This is plain
// HTTP against employer ATS JSON APIs (not bot-blocked like WebFetch), so the search
// agents start from a list of real, live postings instead of fighting 403 pages.
// Non-fatal: if it fails the agents can still run the harvester themselves.
async function runHarvester(parentId) {
  await mkdir(runLogDir, { recursive: true });
  const logPath = resolve(runLogDir, `${parentId}-harvest.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`ATS harvest started: ${new Date().toISOString()}\n`);
  return new Promise((resolveHarvest) => {
    const child = spawn(process.execPath, [resolve(__dirname, "scripts/fetch_ats.mjs")], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", (error) => {
      log.write(`\nATS harvest failed to start: ${error.message}\n`);
      log.end();
      resolveHarvest({ ok: false });
    });
    child.on("close", (code) => {
      log.write(`\nATS harvest finished: ${new Date().toISOString()} (exit ${code})\n`);
      log.end();
      resolveHarvest({ ok: code === 0 });
    });
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const target = resolve(publicDir, `.${pathname}`);
  if (!target.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const type = contentTypes.get(extname(target)) ?? "application/octet-stream";
  const stream = createReadStream(target);
  stream.on("error", () => {
    res.writeHead(404);
    res.end("Not found");
  });
  stream.on("open", () => res.writeHead(200, { "content-type": type }));
  stream.pipe(res);
}

async function serveRequestLog(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestId = url.searchParams.get("id");
  const requests = await readJson(requestsPath, { requests: [] });
  const request = (requests.requests ?? []).find((item) => item.id === requestId);
  if (!request?.logPath) {
    sendJson(res, 404, { ok: false, error: "Log not found" });
    return;
  }

  const target = resolve(root, request.logPath);
  if (!target.startsWith(runLogDir)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  const stream = createReadStream(target);
  stream.on("error", () => {
    sendJson(res, 404, { ok: false, error: "Log not found" });
  });
  stream.on("open", () => res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }));
  stream.pipe(res);
}

async function findRequest(requestId) {
  const requests = await readJson(requestsPath, { requests: [] });
  return (requests.requests ?? []).find((item) => item.id === requestId);
}

// ---- Cover-letter generation ----
// The candidate profile is loaded from config/candidate.json via loadCandidate().

// Find the harvested job-description text for a role (matched by link or company+role).
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ""; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } });
}

// Crude but robust HTML -> readable text (keeps paragraph/list breaks, drops markup).
function htmlToText(html) {
  let t = String(html || "");
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  t = t.replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|section|article)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "• ");
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeEntities(t);
  return t.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Most ATS embed a schema.org JobPosting with a clean `description` field.
function jdFromJsonLd(html) {
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const items = Array.isArray(data) ? data : (Array.isArray(data["@graph"]) ? data["@graph"] : [data]);
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const type = it["@type"];
      const isJob = Array.isArray(type) ? type.includes("JobPosting") : type === "JobPosting";
      if (isJob && it.description) return htmlToText(String(it.description));
    }
  }
  return "";
}

function extractJd(html) {
  const fromLd = jdFromJsonLd(html);
  if (fromLd && fromLd.length >= 200) return fromLd.slice(0, 6000);
  return htmlToText(html).slice(0, 6000);
}

// The real employer/ATS posting to fetch — skip Gmail permalinks and login-walled aggregators.
function bestPostingUrl(role) {
  for (const u of [role.link, role.sourceLink]) {
    if (u && /^https?:\/\//i.test(u) && !/mail\.google\.com|\/mail\/|linkedin\.com|glassdoor\./i.test(u)) return u;
  }
  return "";
}

async function fetchJdViaHttp(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { "user-agent": BROWSER_UA, accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: controller.signal });
    if (!res.ok) return "";
    const ct = res.headers.get("content-type") || "";
    if (!/html|json|text|xml/i.test(ct)) return "";
    return extractJd(await res.text());
  } finally { clearTimeout(timer); }
}

// Fallback for JS-heavy postings (Workday, SPA boards) that return little over plain HTTP.
async function fetchJdViaBrowser(url) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: BROWSER_UA });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);
    const html = await page.content();
    const fromLd = jdFromJsonLd(html);
    if (fromLd && fromLd.length >= 200) return fromLd.slice(0, 6000);
    const bodyText = await page.evaluate(() => {
      for (const s of ["main", "[role=main]", "article", ".job-description", ".posting", "#content", "body"]) {
        const el = document.querySelector(s);
        if (el && el.innerText && el.innerText.trim().length > 200) return el.innerText;
      }
      return document.body ? document.body.innerText : "";
    });
    return htmlToText(bodyText).slice(0, 6000);
  } finally { await browser.close(); }
}

async function fetchLiveJobDescription(url) {
  const viaHttp = await fetchJdViaHttp(url).catch(() => "");
  if (viaHttp && viaHttp.length >= 400) return viaHttp;
  const viaBrowser = await fetchJdViaBrowser(url).catch(() => "");
  if (viaBrowser && viaBrowser.length >= 200) return viaBrowser;
  return viaHttp || viaBrowser || "";
}

// Best available job description: prefer the harvested copy; otherwise fetch the live posting.
async function findJobDescription(role) {
  const bundle = await readJson(resolve(root, "tracking/ats_candidates.json"), { candidates: [] });
  const cands = bundle.candidates ?? [];
  const byLink = role.link && cands.find((c) => c.link === role.link);
  const byId = role.internalId && cands.find((c) => String(c.internalId) === String(role.internalId));
  const byName = cands.find((c) => c.company === role.company && c.role === role.role);
  const harvested = ((byLink || byId || byName)?.description || "").trim();
  if (harvested.length >= 200) return { text: harvested, source: "harvest" };

  const url = bestPostingUrl(role);
  if (url) {
    const live = await fetchLiveJobDescription(url).catch(() => "");
    if (live && live.length >= 200) return { text: live, source: "live" };
  }
  return { text: harvested, source: harvested ? "harvest" : "" };
}

function buildCoverLetterPrompt(role, jd, questions, paragraphs, notes, candidate) {
  const asList = (v) => Array.isArray(v) ? v.filter(Boolean).map(String) : (v ? [String(v)] : []);
  const facts = [];
  if (role.location) facts.push(`Location: ${role.location}`);
  if (role.salaryRange) facts.push(`Compensation: ${role.salaryRange}`);
  if (role.fitRiskSummary) facts.push(`Fit assessment (our internal read, use as guidance, do not quote): ${role.fitRiskSummary}`);
  const pros = asList(role.pros); if (pros.length) facts.push(`Strengths to lean on: ${pros.join("; ")}`);
  const cons = asList(role.cons); if (cons.length) facts.push(`Gaps to handle carefully (do not overclaim): ${cons.join("; ")}`);
  const postingUrl = bestPostingUrl(role) || role.link || "";

  const lines = [
    "You are writing a real job application for the candidate below. Output ONLY the final text the candidate will submit — no preamble, no markdown headings, no 'Here is', no notes to the reader.",
    "",
    `CANDIDATE: ${candidate.profile}`,
    `(You may also read config/candidate.json and the CV at ${candidate.cvPath || "the candidate's CV path"} if accessible for more detail — but do NOT invent facts.)`,
    "",
    `ROLE: ${role.company} — ${role.role}${role.location ? ` (${role.location})` : ""}.${postingUrl ? ` Link: ${postingUrl}` : ""}`,
    "",
    "WHAT WE KNOW ABOUT THIS ROLE (use it to tailor the writing; do not quote our internal notes verbatim and do not invent facts beyond it):",
    facts.length ? facts.map((f) => `- ${f}`).join("\n") : "- (nothing beyond the title, company, and location above)",
    "",
    "JOB DESCRIPTION (the single most important input — tailor everything to what it actually asks for):",
    jd ? jd : "(could not retrieve the full posting — rely on the role title, company, location, and the role facts above)",
    ""
  ];
  const qs = Array.isArray(questions) ? questions.filter((q) => q && q.question && q.question.trim()) : [];
  if (qs.length) {
    lines.push(
      "This application asks the specific questions below. Answer EACH ONE in first person, tailored to THIS role and the candidate's real experience. Label each answer with its question. Use approximately the requested number of paragraphs for each:"
    );
    qs.forEach((q, i) => {
      const p = Number(q.paragraphs) > 0 ? Number(q.paragraphs) : (Number(paragraphs) > 0 ? Number(paragraphs) : 2);
      lines.push(`${i + 1}. ${q.question.trim()}  (~${p} paragraph${p === 1 ? "" : "s"})`);
    });
  } else {
    const p = Number(paragraphs) > 0 ? Number(paragraphs) : 3;
    lines.push(`Write a cover letter of approximately ${p} paragraph${p === 1 ? "" : "s"}, in first person, addressed to the hiring team, tailored to this role.`);
  }
  lines.push(
    "",
    "A paragraph means 3-5 sentences — size each answer/section accordingly.",
    "STYLE: confident, specific, concrete (cite real achievements — trading-systems scale, AI/LLM leadership — that match the JD). No clichés, no filler, no invented facts or metrics. British/neutral English.",
    "",
    "DO NOT REPEAT THE RESUME. Do not rehash every line of the CV as a narrative — pick the 2-3 most relevant experiences for THIS specific role and go deep on them. Highlight what the JD is actually asking for; leave the rest out.",
    "",
    "DO NOT SOUND AI-GENERATED. Write like a thoughtful human, not a language model. Specifically: NEVER use the words/phrases 'delve', 'leverage', 'tapestry', 'testament', 'realm', 'landscape', 'pivotal', 'underscore', 'showcase', 'spearhead', 'passionate about', 'excited to', 'thrilled', 'I am confident that', 'in today's fast-paced world', 'cutting-edge', 'game-changer', 'seamless', 'robust', 'dynamic'. Avoid the 'not only X but also Y' construction, the rule-of-three list everywhere, NEVER use em dashes (—) or en dashes (–) anywhere in the text; replace them with a comma, colon, semicolon, or parentheses. Vary sentence length, use plain direct verbs, and let concrete specifics (systems, numbers, decisions) carry the writing instead of adjectives. It should read like the candidate wrote it themselves in a focused 20 minutes — natural, slightly understated, and human."
  );
  if (notes && notes.trim()) lines.push("", `EXTRA INSTRUCTIONS FROM THE FAMILY: ${notes.trim()}`);
  return lines.join("\n");
}

// Run the Claude CLI non-interactively and capture its printed output.
async function runClaudeCapture(prompt, timeoutMs = 180000) {
  const cfg = await loadAgentConfig();
  return new Promise((resolveText, reject) => {
    const child = spawn(claudeCli, ["-p", "--model", cfg.claude.model, "--effort", cfg.claude.effort, prompt], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("cover-letter generation timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolveText(out.trim());
      else reject(new Error(err.trim() || `claude exited ${code}`));
    });
  });
}

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "role";
}

// Render cover-letter text to a PDF buffer using Playwright (chromium, lazy-loaded).
async function coverLetterPdf(text, { company, role }) {
  const { chromium } = await import("playwright");
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 2.2cm 2cm; }
    body { font-family: Georgia, 'Times New Roman', serif; font-size: 11.5pt; line-height: 1.5; color: #111; }
    .head { font-size: 10pt; color: #444; margin-bottom: 18px; }
    .body { white-space: pre-wrap; }
  </style></head><body>
    <div class="head">${esc(company)} — ${esc(role)}</div>
    <div class="body">${esc(text)}</div>
  </body></html>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}

// Patterns that indicate a failure/deficiency in a run log. These run against a
// 700KB+ log that MIXES harness messages with page content the agent fetched, so
// patterns are deliberately HIGH-CONFIDENCE (anchored / specific phrases) to avoid
// false positives from words like "error"/"quota"/"404" appearing inside job ads.
// Order matters — first match wins per line.
const LOG_ISSUE_PATTERNS = [
  [/ran out of (room|context)|out of context|context window (is )?(full|exceeded)|maximum context length/i, "Context window exhausted — agent ran too long; lower scope / cap web searches"],
  [/hit your session limit|session limit ·|reached your usage limit|usage limit\b.*\breset|quota exceeded|exceeded your (current )?quota|insufficient_quota|429 too many requests/i, "Agent session / usage limit reached"],
  [/EADDRINUSE/i, "Port already in use"],
  [/fetch_ats failed|fetch_browser failed/i, "ATS harvester error"],
  [/^\s*(Agent run failed|Error:|ERROR:|TypeError|ReferenceError|SyntaxError|UnhandledPromiseRejection|Traceback)\b/, "Run error logged"]
];

// Deficiency patterns (informative, not failures): how many sources were unreadable.
// Reported as aggregate counts only when material.
const DEFICIENCY_PATTERNS = [
  [/\b403\b|\bforbidden\b|permission denied/i, "blocked fetches (403 / bot-wall)"],
  [/cloudflare|__cf_chl|just a moment\.\.\./i, "Cloudflare bot-challenge blocks"]
];

function scanLogForIssues(text) {
  const found = new Map(); // label -> { count, sample }
  const deficits = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let matched = false;
    for (const [re, label] of LOG_ISSUE_PATTERNS) {
      if (re.test(line)) {
        const entry = found.get(label) || { count: 0, sample: line.slice(0, 200) };
        entry.count += 1;
        found.set(label, entry);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    for (const [re, label] of DEFICIENCY_PATTERNS) {
      if (re.test(line)) { deficits.set(label, (deficits.get(label) || 0) + 1); break; }
    }
  }
  const issues = [...found.entries()].map(([label, { count, sample }]) => ({ label, count, sample }));
  // Only surface a deficiency if it happened enough to matter (>=3), to avoid noise.
  for (const [label, count] of deficits) {
    if (count >= 3) issues.push({ label: `${count} ${label}`, count, sample: "" });
  }
  return issues;
}

async function readLogIfExists(absPath) {
  try {
    if (!absPath.startsWith(runLogDir)) return null;
    return await readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

// Inspect the logs of the most recent run(s) and report failures/deficiencies,
// even when the agent crashed without writing a run summary.
async function buildRunHealth(limit = 4) {
  const requests = await readJson(requestsPath, { requests: [] });
  const runs = (requests.requests ?? [])
    .filter((r) => r.logPath || r.exitCode != null || r.status === "FAILED")
    .sort((a, b) =>
      Date.parse(b.finishedAt || b.startedAt || b.createdAt || 0) -
      Date.parse(a.finishedAt || a.startedAt || a.createdAt || 0)
    )
    .slice(0, limit);

  const out = [];
  for (const r of runs) {
    const issues = [];
    if (r.status === "FAILED") issues.push({ label: `Run FAILED${r.exitCode != null ? ` (exit ${r.exitCode})` : ""}${r.error ? `: ${r.error}` : ""}`, count: 1, sample: "" });
    if (r.logPath) {
      const text = await readLogIfExists(resolve(root, r.logPath));
      if (text) issues.push(...scanLogForIssues(text));
    }
    // Also scan the sibling harvester log for this run, if any.
    const harvestText = await readLogIfExists(resolve(runLogDir, `${r.id}-harvest.log`));
    if (harvestText) {
      for (const i of scanLogForIssues(harvestText)) issues.push({ ...i, label: `Harvest: ${i.label}` });
    }
    out.push({
      id: r.id,
      type: r.type,
      agent: r.assignedTo || "",
      status: r.status,
      exitCode: r.exitCode ?? null,
      finishedAt: r.finishedAt || r.startedAt || r.createdAt || "",
      logPath: r.logPath || "",
      issues
    });
  }
  return out;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/data") {
      sendJson(res, 200, await loadBundle());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/run-health") {
      sendJson(res, 200, { runs: await buildRunHealth() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/requests") {
      sendJson(res, 200, await readJson(requestsPath, { meta: { version: 1 }, requests: [] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/request-log") {
      await serveRequestLog(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/save") {
      const payload = await readBody(req);
      const currentData = await readJson(dataPath, payload.data ?? {});
      const mergedData = mergeDashboardEdits(currentData, payload.data ?? {});
      await saveData(mergedData);
      sendJson(res, 200, { ok: true, updatedAt: mergedData.meta.updatedAt });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/request") {
      const payload = await readBody(req);
      const request = await addRequest(payload);
      if (payload.runNow) {
        const running = await runRequest(request);
        sendJson(res, 200, { ok: true, request: running });
        return;
      }
      sendJson(res, 200, { ok: true, request });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/run-agent") {
      const payload = await readBody(req);
      const agent = payload.agent === "claude" ? "claude" : payload.agent === "codex" ? "codex" : null;
      if (!agent) {
        sendJson(res, 400, { ok: false, error: "agent must be 'claude' or 'codex'" });
        return;
      }
      const type = agent === "claude" ? "CLAUDE_FULL_RUN" : "CODEX_FULL_RUN";
      // The run popup carries the model/effort choice. Persist it as this agent's
      // config (preserving the other agent) so the spawn — which reads
      // agent_config.json — uses it, and it becomes the new default next time.
      if (payload.model || payload.effort) {
        const current = sanitizeAgentConfig(await readJson(agentConfigPath, {}));
        const merged = sanitizeAgentConfig({
          ...current,
          [agent]: {
            model: payload.model ?? current[agent].model,
            effort: payload.effort ?? current[agent].effort
          }
        });
        await writeJsonAtomic(agentConfigPath, { meta: { version: 1, updatedAt: new Date().toISOString() }, ...merged });
      }
      const request = await addRequest({
        type,
        assignedTo: agent,
        title: `Run ${agent} (solo full run)`,
        notes: payload.notes ?? "",
        includeMunichParis: payload.includeMunichParis === true,
        phases: payload.phases
      });
      // Mark RUNNING right away: the ATS harvest takes ~30-40s before the agent
      // spawns, and we don't want the row to sit OPEN (which shows a manual "Run"
      // button and makes it look idle / lets it be double-triggered).
      const running = await updateRequest(request.id, {
        status: "RUNNING",
        assignedTo: agent,
        startedAt: new Date().toISOString(),
        currentStep: "harvest",
        searchedCompanies: await searchedCompaniesByCategory()
      });
      // Decoupled solo run: refresh the ATS harvest, then run the one agent.
      // A single process — one agent's crash/quota never affects the other button.
      (async () => {
        await runHarvester(request.id);
        await runRequestAndWait(request);
      })().catch(async (error) => {
        await updateRequest(request.id, {
          status: "FAILED",
          finishedAt: new Date().toISOString(),
          error: error.message
        });
      });
      sendJson(res, 200, { ok: true, request: running ?? request });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cover-letter") {
      const payload = await readBody(req);
      const data = await readJson(dataPath, { roles: [] });
      const role = (data.roles ?? []).find((r) => r.id === payload.roleId);
      if (!role) {
        sendJson(res, 404, { ok: false, error: "Role not found" });
        return;
      }
      try {
        const jd = await findJobDescription(role);
        const candidate = await loadCandidate();
        const prompt = buildCoverLetterPrompt(role, jd.text, payload.questions, payload.paragraphs, payload.notes, candidate);
        const text = await runClaudeCapture(prompt);
        // Not saved automatically — the user reviews/edits, then saves explicitly
        // via the Save button (POST /api/cover-letter/save).
        sendJson(res, 200, { ok: true, text, hadJd: Boolean(jd.text), jdSource: jd.source });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cover-letter/save") {
      const payload = await readBody(req);
      const text = String(payload.text || "").trim();
      if (!text) {
        sendJson(res, 400, { ok: false, error: "No text to save" });
        return;
      }
      try {
        const prefix = payload.kind === "questions" ? "answers" : "cover_letter";
        const filename = `${prefix}_${slugify(payload.company)}_${slugify(payload.role)}.md`;
        await mkdir(resolve(root, "cover_letters"), { recursive: true });
        await writeFile(resolve(root, `cover_letters/${filename}`), text + "\n", "utf8");
        sendJson(res, 200, { ok: true, path: `cover_letters/${filename}` });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cover-letter/pdf") {
      const payload = await readBody(req);
      const text = String(payload.text || "").trim();
      if (!text) {
        sendJson(res, 400, { ok: false, error: "No text to render" });
        return;
      }
      try {
        const pdf = await coverLetterPdf(text, { company: payload.company || "", role: payload.role || "" });
        const prefix = payload.kind === "questions" ? "form_answers" : "cover_letter";
        const filename = `${prefix}_${slugify(payload.company)}_${slugify(payload.role)}.pdf`;
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${filename}"`,
          "content-length": pdf.length
        });
        res.end(pdf);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/run-request") {
      const payload = await readBody(req);
      const request = await findRequest(payload.id);
      if (!request) {
        sendJson(res, 404, { ok: false, error: "Request not found" });
        return;
      }
      if (request.status === "RUNNING") {
        sendJson(res, 409, { ok: false, error: "Request is already running" });
        return;
      }
      const running = await runRequest(request);
      sendJson(res, 200, { ok: true, request: running });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/regenerate-markdown") {
      const data = await readJson(dataPath, {});
      await writeFile(reportPath, generateMarkdown(data), "utf8");
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/agent-config") {
      sendJson(res, 200, {
        ok: true,
        config: await loadAgentConfig(),
        options: {
          claudeModels: CLAUDE_MODELS,
          claudeEfforts: CLAUDE_EFFORTS,
          codexModels: CODEX_MODELS,
          codexEfforts: CODEX_EFFORTS
        },
        envOverride: {
          claudeModel: Boolean(process.env.CLAUDE_MODEL),
          claudeEffort: Boolean(process.env.CLAUDE_EFFORT),
          codexModel: Boolean(process.env.CODEX_MODEL),
          codexEffort: Boolean(process.env.CODEX_EFFORT)
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/agent-config") {
      const payload = await readBody(req);
      const config = sanitizeAgentConfig(payload);
      await writeJsonAtomic(agentConfigPath, {
        meta: { version: 1, updatedAt: new Date().toISOString() },
        ...config
      });
      sendJson(res, 200, { ok: true, config });
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Job search dashboard: http://127.0.0.1:${port}`);
});
