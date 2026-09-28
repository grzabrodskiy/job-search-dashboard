#!/usr/bin/env node
// ATS harvester. Pulls live postings from employers' ATS JSON APIs (Greenhouse,
// Lever, Ashby, SmartRecruiters, Workday) instead of scraping HTML career pages.
// The JSON APIs are not bot-blocked the way the rendered pages are (WebFetch gets
// 403 on Google/Lever/Ashby/etc.), so this gives the search agents clean, real
// candidates — title, location, internal ID, direct apply URL — to curate.
//
// Output: tracking/ats_candidates.json (staging file the search step reads).
// Usage:  node dashboard/scripts/fetch_ats.mjs
// This is plain HTTP (global fetch); it works for any caller, agent or human.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..");
const configPath = resolve(__dirname, "ats_sources.json");
const outPath = resolve(root, "tracking/ats_candidates.json");
// Verdicts agents have already reached on harvested candidates. Without this the same
// few hundred rows are re-triaged from scratch every run and the budget goes on
// re-rejecting known non-fits instead of reading genuinely new postings.
const decisionsPath = resolve(root, "tracking/candidate_decisions.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 25000; // higher: Greenhouse content=true returns large payloads
const SOURCE_CONCURRENCY = 5; // sources fetched in parallel; the work is network-bound
// Job-description text. Adapters keep a generous amount at fetch time; main() then
// clamps each row to a region-aware budget so the candidate file stays reasonable.
// Primary-region rows get the larger budget — those are the ones agents actually
// score in detail.
const JD_MAX = 20000; // fetch-time ceiling, guards against pathological pages
const JD_PRIMARY_MAX = 5000;
const JD_BACKUP_MAX = 2800;
const JD_ELISION = "\n\n[… middle of description elided …]\n\n";
// Below this many characters a description is a skills list or a stub, not an ad.
const THIN_JD = 300;

// A plain head-truncation cut off exactly what the rubric needs: required years,
// language demands and work-authorization notes live at the END of a job ad, not the
// start, which is company boilerplate. Agents flagged this in three consecutive run
// summaries ("late qualification blocks can remain truncated"). Keep the opening AND
// the closing of a long description and drop the middle instead.
function clampJd(text, max) {
  const t = String(text || "");
  if (t.length <= max) return t;
  const budget = max - JD_ELISION.length;
  const head = Math.floor(budget * 0.55);
  return t.slice(0, head) + JD_ELISION + t.slice(-(budget - head));
}

// Convert (possibly entity-escaped) HTML to trimmed plain text, capped at JD_MAX.
// Greenhouse `content` is HTML-escaped HTML, so we decode entities, strip tags,
// then decode again for any inner entities.
function htmlToText(raw, max = JD_MAX) {
  if (!raw) return "";
  const decode = (s) =>
    s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&rsquo;|&apos;/gi, "'")
      .replace(/&[a-z0-9#]+;/gi, " ");
  let t = decode(String(raw));
  t = t.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>/gi, "\n").replace(/<[^>]+>/g, " ");
  t = decode(t).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// Reads JSON that may legitimately not exist yet (first run, or no decisions recorded).
// Any OTHER failure is loud: this project lives in iCloud Drive, and an evicted
// ("dataless") file that fails to download would otherwise silently reset every row to
// isNew and drop the whole decision ledger for the run.
async function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`⚠ could not read ${path}: ${err.message} — continuing without it`);
    return fallback;
  }
}

async function getText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.text() };
  } catch (err) {
    return { error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (err) {
    return { error: err.name === "AbortError" ? "timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Provider adapters: normalize to {role, location, internalId, link} ----

async function fetchGreenhouse(slug) {
  // content=true returns the full job description for every posting in one call.
  const { data, error } = await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`
  );
  if (error) return { error };
  return {
    jobs: (data.jobs ?? []).map((j) => ({
      role: j.title,
      location: j.location?.name ?? "",
      internalId: String(j.internal_job_id ?? j.id ?? ""),
      link: j.absolute_url,
      description: htmlToText(j.content)
    }))
  };
}

async function fetchLever(slug) {
  const { data, error } = await getJson(
    `https://api.lever.co/v0/postings/${slug}?mode=json`
  );
  if (error) return { error };
  return {
    jobs: (Array.isArray(data) ? data : []).map((j) => ({
      role: j.text,
      location: j.categories?.location ?? (j.categories?.allLocations || []).join(", "),
      internalId: String(j.id ?? ""),
      link: j.hostedUrl,
      description: (j.descriptionPlain || "").slice(0, JD_MAX)
    }))
  };
}

async function fetchAshby(slug) {
  const { data, error } = await getJson(
    `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`
  );
  if (error) return { error };
  return {
    jobs: (data.jobs ?? []).map((j) => ({
      role: j.title,
      location: j.location ?? j.locationName ?? "",
      internalId: String(j.id ?? ""),
      link: j.jobUrl ?? j.applyUrl ?? "",
      description: (j.descriptionPlain || "").slice(0, JD_MAX),
      comp: j.compensation?.compensationTierSummary || ""
    }))
  };
}

// SmartRecruiters listing endpoint omits the full job description. We do a per-posting
// detail fetch for Switzerland/Germany/France-located postings (the only locations we
// care about) to populate the description field, using parallel batches of 8.
const SR_LOC_HINTS = ["switzerland", "suisse", "schweiz", "ch", "zurich", "zürich", "zug",
  "geneva", "genève", "gland", "basel", "bern", "lausanne", "lugano",
  "germany", "münchen", "munich", "france", "paris"];
const SR_BATCH = 8;
async function fetchSmartRecruiters(slug) {
  const { data, error } = await getJson(
    `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`
  );
  if (error) return { error };
  const list = data.content ?? [];

  async function enrichPosting(j) {
    const city = j.location?.city ?? "";
    const country = j.location?.country ?? "";
    const loc = `${city} ${country}`.toLowerCase();
    const wantDetail = SR_LOC_HINTS.some((h) => loc.includes(h));
    let description = "";
    if (wantDetail) {
      const detail = await getJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${j.id}`);
      if (!detail.error && detail.data?.jobAd?.sections) {
        description = Object.values(detail.data.jobAd.sections)
          .map((s) => htmlToText(s.text || ""))
          .filter(Boolean)
          .join("\n\n")
          .slice(0, JD_MAX);
      }
    }
    return {
      role: j.name,
      location: [city, country].filter(Boolean).join(", "),
      internalId: String(j.id ?? j.refNumber ?? ""),
      link: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
      description
    };
  }

  const jobs = [];
  for (let i = 0; i < list.length; i += SR_BATCH) {
    const results = await Promise.allSettled(list.slice(i, i + SR_BATCH).map(enrichPosting));
    for (const r of results) {
      if (r.status === "fulfilled") jobs.push(r.value);
    }
  }
  return { jobs };
}

// Workday: slug is "<tenant>/<site>", host is the *.myworkdayjobs.com host.
// Workday caps page size at 20 and paginates, so big banks (1000+ reqs) need many
// pages. We narrow with one or more searchText queries (source.queries, e.g.
// ["engineer","developer"]) and page each up to WORKDAY_MAX_PAGES, unioning results.
// NOTE: searchText is a KEYWORD search over the posting, not a location filter —
// passing city names ("Zurich") returns only postings whose text happens to mention
// the city, which is an arbitrary subset. Prefer [""] (enumerate the whole board and
// let the location filter do the work) and reserve keyword queries for boards too
// large to page through.
const WORKDAY_PAGE = 20;
const WORKDAY_MAX_PAGES = 20;
const WORKDAY_DETAIL_BATCH = 6;
const WORKDAY_PAGE_BATCH = 5;
// Multi-site postings come back as "3 Locations" instead of a city. Those rows match
// no location filter, so they used to be dropped wholesale (47 at one insurer alone).
// The detail endpoint resolves them, so we hydrate the ones whose TITLE already looks
// relevant — no point resolving the cities of a Personal Assistant req — up to a cap
// that keeps a 1,400-req board from turning into 1,400 detail fetches.
const WORKDAY_MULTI_LOC = /^\s*\d+\s+locations\s*$/i;
const WORKDAY_UNKNOWN_LOC_CAP = 80;
async function fetchWorkday(source, filters) {
  const { slug, host } = source;
  if (!host) return { error: "workday source needs a host" };
  const site = slug.split("/")[1] ?? "";
  const url = `https://${host}/wday/cxs/${slug}/jobs`;
  const queries = source.queries ?? [""];
  const byPath = new Map();
  let firstError = null;
  const page = (offset, q) =>
    getJson(url, { method: "POST", body: { appliedFacets: {}, limit: WORKDAY_PAGE, offset, searchText: q } });
  const absorb = (postings) => {
    let added = 0;
    for (const j of postings ?? []) {
      const path = j.externalPath ?? `${j.title}-${j.bulletFields?.[0] ?? ""}`;
      if (byPath.has(path)) continue;
      byPath.set(path, {
        role: j.title,
        location: j.locationsText ?? "",
        internalId: String(j.bulletFields?.[0] ?? ""),
        link: `https://${host}/en-US/${site}${j.externalPath ?? ""}`,
        path: j.externalPath ?? ""
      });
      added++;
    }
    return added;
  };

  for (const q of queries) {
    // Workday reports a real `total` on the FIRST page only; every later page returns
    // total: 0. Comparing against that zero ended pagination after two pages and
    // silently truncated the board (Julius Baer: 40 of 83 "Zurich" matches fetched).
    // Read the total once from page 0 and treat a missing/zero value as "unknown".
    const first = await page(0, q);
    if (first.error) {
      if (byPath.size === 0) firstError = first.error;
      continue;
    }
    const total = Number(first.data.total) || 0;
    const firstBatch = first.data.jobPostings ?? [];
    absorb(firstBatch);
    if (firstBatch.length < WORKDAY_PAGE) continue;

    if (total > 0) {
      // Total known: the remaining offsets are known too, so fetch them concurrently
      // rather than walking a 1,400-req board twenty rows at a time.
      const lastPage = Math.min(WORKDAY_MAX_PAGES, Math.ceil(total / WORKDAY_PAGE));
      for (let p = 1; p < lastPage; p += WORKDAY_PAGE_BATCH) {
        const offsets = [];
        for (let k = p; k < Math.min(p + WORKDAY_PAGE_BATCH, lastPage); k++) offsets.push(k * WORKDAY_PAGE);
        const results = await Promise.allSettled(offsets.map((o) => page(o, q)));
        for (const r of results) {
          if (r.status === "fulfilled" && !r.value.error) absorb(r.value.data.jobPostings);
        }
      }
    } else {
      // Total unknown: walk sequentially until a short page or a page that adds nothing.
      for (let p = 1; p < WORKDAY_MAX_PAGES; p++) {
        const { data, error } = await page(p * WORKDAY_PAGE, q);
        if (error) break;
        const postings = data.jobPostings ?? [];
        const added = absorb(postings);
        if (postings.length < WORKDAY_PAGE || added === 0) break;
      }
    }
  }
  // Only report failure if NOTHING came back: one bad query among several must not
  // discard the rows the other queries found (the SuccessFactors adapter already
  // guards this way).
  if (firstError && byPath.size === 0) return { error: firstError };

  // The list endpoint omits the JD. Hydrate target-region rows from the CXS detail
  // endpoint, which also returns `canApply` — a first-class liveness signal that is
  // more reliable than inferring closure from harvest absence.
  const jobs = [...byPath.values()];
  const inRegion = (j) => SR_LOC_HINTS.some((h) => j.location.toLowerCase().includes(h));
  const unresolved = jobs
    .filter((j) => WORKDAY_MULTI_LOC.test(j.location) && titleAllowed(j.role, filters))
    .slice(0, WORKDAY_UNKNOWN_LOC_CAP);
  const wanted = [...jobs.filter(inRegion), ...unresolved];
  for (let i = 0; i < wanted.length; i += WORKDAY_DETAIL_BATCH) {
    await Promise.allSettled(
      wanted.slice(i, i + WORKDAY_DETAIL_BATCH).map(async (j) => {
        if (!j.path) return;
        const { data, error } = await getJson(`https://${host}/wday/cxs/${slug}${j.path}`);
        if (error || !data?.jobPostingInfo) return;
        const info = data.jobPostingInfo;
        j.description = htmlToText(info.jobDescription || "");
        if (info.canApply === false) j.canApply = false;
        if (info.jobReqId) j.internalId = String(info.jobReqId);
        // Replace "3 Locations" with the cities the detail page names, so the
        // location filter can finally see them.
        if (WORKDAY_MULTI_LOC.test(j.location)) {
          const cities = [...new Set([info.location, ...(info.additionalLocations ?? [])].filter(Boolean))];
          if (cities.length) j.location = cities.join(", ");
        }
      })
    );
  }
  for (const j of jobs) delete j.path;
  return { jobs };
}

// Google careers isn't a standard ATS. Its results page (google.com, NOT the
// 403-blocked careers.google.com) returns 200 and the ?location= param really
// filters server-side (Zurich vs Tokyo share zero results). We query per target
// location and parse the stable jobs/results/<id>-<title-slug> links, then
// fetch each job's detail page to extract the full JD (About the job +
// Minimum/Preferred qualifications) — these detail pages also return 200.
function deSlug(slug) {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
function extractGoogleJD(html) {
  const sections = ["About the job", "Minimum qualifications", "Preferred qualifications", "Responsibilities"];
  const parts = [];
  for (const section of sections) {
    const idx = html.indexOf(section);
    if (idx < 0) continue;
    // Take up to 1500 chars from this section start, strip HTML
    const chunk = html.slice(idx, idx + 1500)
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div|ul|ol)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&[a-z0-9#]+;/gi, " ")
      .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    // Stop at the next major section heading to avoid duplication
    const stop = Math.min(...sections.filter(s => s !== section).map(s => { const i = chunk.indexOf(s); return i > 0 ? i : Infinity; }));
    parts.push(stop < Infinity ? chunk.slice(0, stop).trim() : chunk);
  }
  return [...new Set(parts)].join("\n\n").slice(0, JD_MAX);
}
const GOOGLE_BATCH = 6;
// Each listing page holds ~20 results and the rest sit behind &page=N. Reading only
// page 1 meant a Google role could be absent from the harvest while still live, so
// harvest absence was not usable as closure evidence and every Google archival needed
// a manual page fetch to confirm. Page through until a page adds nothing new.
const GOOGLE_MAX_PAGES = 6;
async function fetchGoogle(source) {
  const locations = source.locations ?? ["Zurich, Switzerland"];
  const queries = source.queries ?? ["software engineer"];
  // Phase 1: scrape listing pages to collect (id, slug, location) triples
  const byId = new Map();
  for (const loc of locations) {
    for (const q of queries) {
      for (let page = 1; page <= GOOGLE_MAX_PAGES; page++) {
        const url =
          "https://www.google.com/about/careers/applications/jobs/results/" +
          `?location=${encodeURIComponent(loc)}&q=${encodeURIComponent(q)}` +
          (page > 1 ? `&page=${page}` : "");
        const { data, error } = await getText(url);
        if (error) break;
        const re = /jobs\/results\/(\d{6,})-([a-z0-9-]+)/g;
        let m;
        let added = 0;
        let seenOnPage = 0;
        while ((m = re.exec(data)) !== null) {
          const [, id, slug] = m;
          seenOnPage++;
          if (byId.has(id)) continue;
          byId.set(id, { id, slug, location: loc });
          added++;
        }
        // An empty page is the end of the result set; a page that repeats what we
        // already hold means Google stopped advancing and further pages are wasted.
        if (seenOnPage === 0 || added === 0) break;
      }
    }
  }
  if (byId.size === 0) return { error: "no jobs parsed (page format may have changed)" };
  // Phase 2: fetch each detail page in batches to get the full JD
  const entries = [...byId.values()];
  const jobs = [];
  for (let i = 0; i < entries.length; i += GOOGLE_BATCH) {
    const batch = entries.slice(i, i + GOOGLE_BATCH);
    const results = await Promise.allSettled(batch.map(async ({ id, slug, location }) => {
      const link = `https://www.google.com/about/careers/applications/jobs/results/${id}-${slug}`;
      const { data, error } = await getText(link);
      const description = (!error && data) ? extractGoogleJD(data) : "";
      return { role: deSlug(slug), location, internalId: id, link, description };
    }));
    for (const r of results) {
      if (r.status === "fulfilled") jobs.push(r.value);
    }
  }
  return { jobs };
}

// SAP SuccessFactors career sites (SIX Group, Swiss Re, Deutsche Börse/Eurex, and
// most large Swiss financial employers). The rendered search page returns 200 over
// plain HTTP — no Cloudflare/bot wall on the `jobs.*`/`careers.*` SF host, unlike the
// corporate marketing site. Rows carry title, requisition id and city; the detail
// page at /job/<City-Title>/<id>/ carries the JD.
// Source shape: { provider:"successfactors", host:"jobs.six-group.com", queries:[...] }
const SF_PAGE = 25;
const SF_MAX_PAGES = 8;
const SF_DETAIL_BATCH = 6;
async function fetchSuccessFactors(source) {
  const { host } = source;
  if (!host) return { error: "successfactors source needs a host" };
  const queries = source.queries ?? ["engineer", "developer", "software"];
  const byId = new Map();
  let firstError = null;

  for (const q of queries) {
    for (let page = 0; page < SF_MAX_PAGES; page++) {
      const url = `https://${host}/search/?q=${encodeURIComponent(q)}&startrow=${page * SF_PAGE}`;
      const { data, error } = await getText(url);
      if (error) {
        if (page === 0 && byId.size === 0) firstError = error;
        break;
      }
      // One <tr class="data-row"> per posting; take the first jobTitle-link and the
      // jobLocation span that follows it.
      const rows = data.split('class="data-row"').slice(1);
      let added = 0;
      for (const row of rows) {
        const link = row.match(/href="([^"]*\/job\/[^"]*?(\d{5,})\/?)"[^>]*class="jobTitle-link"[^>]*>([^<]+)/);
        if (!link) continue;
        const [, href, id, title] = link;
        if (byId.has(id)) continue;
        const locMatch = row.match(/<span class="jobLocation">\s*([^<]+?)\s*</);
        byId.set(id, {
          role: htmlToText(title, 200),
          location: locMatch ? locMatch[1].trim() : "",
          internalId: id,
          link: `https://${host}${href.startsWith("/") ? href : `/${href}`}`
        });
        added++;
      }
      if (rows.length < SF_PAGE || added === 0) break;
    }
  }
  if (firstError && byId.size === 0) return { error: firstError };

  // Hydrate descriptions for target-region rows only (keeps the run bounded).
  const jobs = [...byId.values()];
  const wanted = jobs.filter((j) => SR_LOC_HINTS.some((h) => j.location.toLowerCase().includes(h)));
  for (let i = 0; i < wanted.length; i += SF_DETAIL_BATCH) {
    await Promise.allSettled(
      wanted.slice(i, i + SF_DETAIL_BATCH).map(async (j) => {
        const { data, error } = await getText(j.link);
        if (error || !data) return;
        // The JD lives in a `jobdescription` div/span, but SF nests many inner
        // elements — matching to the first closing tag truncates it. Take a
        // generous slice from the element start and let htmlToText cap it.
        // (The `<style>` block also mentions `.jobdescription`; requiring a real
        // div/span tag before the class keeps us off the CSS.)
        const start = data.search(/<(?:div|span)[^>]*class="[^"]*jobdescription[^"]*"[^>]*>/i);
        if (start < 0) return;
        const text = htmlToText(data.slice(start, start + 20000));
        if (text.length > 80) j.description = text;
      })
    );
  }
  return { jobs };
}

// ---- Candidate identity, tagging and scoring ----

// Company names arrive as legal entities — "On AG", "Bank Julius Bär & Co. AG",
// "Zürich Versicherungs-Gesellschaft AG" — and must collapse to the same key as our own
// labels ("On (On Running)", "Julius Baer") or an aggregator row double-logs a posting
// the ATS harvest already carries.
const COMPANY_NOISE = /\b(ag|sa|sarl|gmbh|ltd|limited|plc|inc|holding|holdings|group|gruppe|groupe|bank|banque|cie|co|company|schweiz|suisse|switzerland|international|beteiligungen|engineering|services|solutions)\b/g;
// Explicit variant -> canonical map, filled from ats_sources.json. Diacritic folding and
// suffix stripping get most of the way, but not all: "On AG" and "On (On Running)" share
// no usable stem. An auditable alias list beats a clever heuristic that silently merges
// two genuinely different employers.
let COMPANY_ALIASES = new Map();

// Fold diacritics to the BASE letter and collapse the German digraphs onto it too, so
// "Bär", "Baer" and "Bar" — and "Zühlke" vs "Zuhlke" — all land on one key. Folding only
// one way (ä -> ae) would fix Julius Baer while breaking Zühlke.
function foldDiacritics(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u").replace(/ss/g, "s");
}

function normalizeCompany(name) {
  const base = foldDiacritics(String(name || "").toLowerCase())
    .replace(/\([^)]*\)/g, " ")   // "On (On Running)" -> "on"
    .replace(/[&.,()\/]/g, " ")
    .replace(COMPANY_NOISE, " ")
    .replace(/[^a-z0-9]+/g, "");
  return COMPANY_ALIASES.get(base) ?? base;
}

// Stable identity for a posting ACROSS harvests. internalId is the strongest signal;
// fall back to normalized company + title where a source exposes no id. A re-listed
// role gets a fresh internalId and so correctly re-enters as new rather than inheriting
// a stale rejection.
function candidateKey(c) {
  const co = normalizeCompany(c.company);
  const id = String(c.internalId || "").trim().toLowerCase();
  if (id && id !== "not exposed") return `${co}|${id}`;
  return `${co}|${String(c.role || "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

// Deterministic signals computed from data we already hold. These TAG AND RANK — they
// never drop a row. Every silent-loss bug in this file's history (gland/England,
// cto/Director, ", ch"/Shanghai) came from a filter deciding on its own that something
// was irrelevant, so judgement stays with the agent and this only reorders the queue.
const RE_DEV_FIRST = /software engineer|software developer|backend|back-end|full.?stack|platform engineer|staff engineer|principal engineer|applied ai|forward deployed|machine learning engineer|ml engineer|quant|programmer|entwickler|développeur/i;
const RE_SENIORITY = /\b(senior|sr\.?|lead|leitende|staff|principal|head of|vice president|vp|director|architekt|architect)\b/i;
const RE_OPS = /devops|sre\b|site reliability|security engineer|infrastructur|network engineer|\bsap\b|abap|m365|sharepoint|citrix|helpdesk|service desk|observability|kubernetes|openshift|ansible|terraform|system engineer|systems engineer|operation/i;
const RE_CONTRACT = /external payroll|contract through|temporary|befristet|interim|freelance/i;
const RE_WEAK_LANG = /\bc\+\+|\bc#|\.net\b/i;
const RE_LANG_BAR = /\b(fluent|proficient|native|verhandlungssicher|fliessend)\b[^.]{0,40}\b(german|deutsch|french|français|französisch)\b|\b(german|deutsch|french)\b[^.]{0,30}\b(required|mandatory|erforderlich|vorausgesetzt)\b/i;

function tagCandidate(c, consultancyKeys) {
  const title = String(c.role || "");
  const text = `${title}\n${c.description || ""}`;
  const tags = [];
  let score = 0;

  if (RE_DEV_FIRST.test(title)) { tags.push("developer-first"); score += 3; }
  if (RE_SENIORITY.test(title)) { tags.push("senior"); score += 2; }
  if (RE_OPS.test(title)) { tags.push("ops-shaped"); score -= 3; }
  if (consultancyKeys.has(normalizeCompany(c.company)) || /consultant|consulting/i.test(title)) {
    tags.push("consultancy"); score -= 2;
  }
  // jobs.ch ships a structured language requirement; everywhere else we read the ad.
  const structuredBar = Array.isArray(c.languageSkills)
    && c.languageSkills.some((l) => ["de", "fr"].includes(l.language) && Number(l.level) >= 3);
  if (structuredBar || RE_LANG_BAR.test(text)) { tags.push("language-bar"); score -= 2; }
  if (RE_CONTRACT.test(text)) { tags.push("contract"); score -= 2; }
  if (RE_WEAK_LANG.test(title)) { tags.push("weak-language"); score -= 1; }
  if (c.sourceType === "aggregator") tags.push("aggregator");

  return { tags, fitScore: score };
}

// Adapters take (source, filters); only Workday currently needs the filters, to
// decide which unresolved multi-location rows are worth a detail fetch.
// Goldman Sachs runs its own careers platform (higher.gs.com) rather than a standard
// ATS. Its Apollo gateway exposes an unauthenticated `roleSearch` query returning
// title, corporate title, division, locations, full HTML description, salary band and
// the Oracle requisition id — everything the rubric needs, with no bot wall.
//
// EXPERIENCES IS A SCOPE BOUNDARY, NOT A TUNING KNOB: the schema separates
// PROFESSIONAL (the public external board) from INTERNAL_MOBILITY (the employee-login
// platform). config/candidate.json's currentEmployerExclusion forbids the internal
// platform, so INTERNAL_MOBILITY is stripped here regardless of what a source config
// asks for — external applications only.
const GS_PAGE = 100;
const GS_MAX_PAGES = 15;
const GS_QUERY =
  "query($q:RoleSearchQueryInput!){roleSearch(searchQueryInput:$q){totalCount items{" +
  "roleId jobTitle corporateTitle division status locations{city country} " +
  "descriptionHtml compensation{minSalary maxSalary currency} externalSource{sourceId}}}}";
async function fetchGoldman(source) {
  const host = source.host || "api-higher.gs.com";
  const url = `https://${host}/gateway/api/v1/graphql`;
  const experiences = (source.experiences ?? ["PROFESSIONAL"]).filter((e) => e !== "INTERNAL_MOBILITY");
  if (!experiences.length) return { error: "goldman source needs a non-internal experience" };
  const byId = new Map();
  let firstError = null;
  for (let page = 0; page < GS_MAX_PAGES; page++) {
    const { data, error } = await getJson(url, {
      method: "POST",
      body: {
        query: GS_QUERY,
        variables: { q: { page: { pageSize: GS_PAGE, pageNumber: page }, experiences, searchTerm: source.searchTerm ?? "" } }
      }
    });
    if (error) {
      if (page === 0) firstError = error;
      break;
    }
    if (data.errors?.length) {
      if (page === 0) firstError = data.errors[0]?.message ?? "graphql error";
      break;
    }
    const items = data.data?.roleSearch?.items ?? [];
    for (const r of items) {
      if (!r.roleId || byId.has(r.roleId)) continue;
      if (/closed|filled|inactive/i.test(String(r.status ?? ""))) continue;
      const c = r.compensation ?? {};
      // The public role page is keyed by the NUMERIC requisition id, not by roleId.
      // higher.gs.com/roles/161025 renders the posting; the roleId form
      // (161025_GS_MID_CAREER) returns HTTP 200 with an empty SPA shell, so it looks
      // fine to a status-code check and is a dead link to a human.
      const sourceId = String(r.externalSource?.sourceId || "").trim() || String(r.roleId).split("_")[0];
      byId.set(r.roleId, {
        role: r.jobTitle,
        // Every city, so a multi-location req can still match the location filter.
        location: (r.locations ?? []).map((l) => [l.city, l.country].filter(Boolean).join(", ")).join("; "),
        internalId: sourceId,
        link: `https://higher.gs.com/roles/${sourceId}`,
        description: htmlToText(r.descriptionHtml),
        comp: c.minSalary && c.maxSalary ? `${c.minSalary}-${c.maxSalary} ${c.currency ?? ""}`.trim() : ""
      });
    }
    if (items.length < GS_PAGE) break;
  }
  if (firstError && byId.size === 0) return { error: firstError };
  return { jobs: [...byId.values()] };
}

// jobs.ch (and its Romandie sibling jobup.ch) run the same public search API, no auth.
// This is the only route to a large slice of the Swiss market: employers whose own ATS
// we cannot fetch at all still advertise here — Pictet, whose careers domain no longer
// resolves in DNS, posts a dozen roles. It does NOT reach UBS, Sygnum or Avaloq, which
// stay on _MANUAL_CHECKS.
//
// Rows are AGGREGATOR rows: the link is a job-board URL, not an employer career page.
// That is a deliberate, family-approved exception to the direct-link rule — the role is
// logged with linkStatus UNVERIFIED and the employer link resolved later, because
// dropping the row would lose exactly the employers nothing else covers.
// 2026-08-28: `/api/v1/public/search` now answers HTTP 410 Gone with an empty body and
// there is no v2 — the SEARCH endpoint died, and two runs read that as "jobs.ch is down"
// and lost the whole Swiss mid-market. It is not down. Two other surfaces are live:
//
//   1. the SERP page `/en/vacancies/?term=…` (jobup.ch: `/en/jobs/?term=…`) server-renders
//      a schema.org ItemList of JobPosting objects — title, employer, city, uuid, date;
//   2. the DETAIL endpoint `/api/v1/public/search/job/<uuid>` still returns 200 with the
//      full record: `template_text` (the whole ad, not the old truncated `preview`),
//      `language_skills`, `place`, `is_active` and `application_url` — the EMPLOYER's own
//      apply link, which is what upgrades an aggregator row to a verifiable one.
//
// So: list from the SERP's structured JSON, then spend one detail request per row that
// passes the title filter. Listing rows are cheap and details are not, which is why the
// filter runs in between — same reason the Workday adapter takes `filters`.
//
// 2026-09-28 — COVERAGE. Search terms are OR-matched and relevance-ranked ("senior
// software engineer" = 1,730 hits), so reading 4 pages per term sampled the top ~5% and
// reached about half of the relevant board. Two listing modes now:
//   - `categories`: the board's own IT category (jobs.ch 106, jobup.ch 702 — ~1,600 and
//     ~1,000 postings), paged to the end. This is the complete IT market and is fewer
//     requests than the old term x city grid.
//   - `queries`: a few pages per term, for roles employers file OUTSIDE the IT category
//     (Pictet, CERN, SonarSource, Vitol and the quant desks all post under banking,
//     research or industry categories).
// The page count comes from the SERP's embedded search state (`numPages`), not from
// "did this page add anything": with terms running concurrently, a page full of rows
// another term already returned said nothing about whether the next page was empty.
const JOBSCH_QUERY_PAGES = 5;
const JOBSCH_CATEGORY_MAX_PAGES = 150;   // guard: jobs.ch IT is ~82 pages today
const JOBSCH_SERP_CONCURRENCY = 6;
const JOBSCH_DETAIL_CONCURRENCY = 8;
// Detail requests are ~20ms and never failed in testing. The old 400 cap, spent newest-
// first, left 131 rows with no description on 2026-09-27 — and a row with no JD cannot
// clear the rubric, so it was rejected instead of read. Cover every title-passing row.
const JOBSCH_MAX_DETAILS = 2000;
const COUNTRY_NAMES = { CH: "Switzerland", LI: "Liechtenstein", DE: "Germany", FR: "France", AT: "Austria", IT: "Italy" };

function jobsChSearchPath(host) {
  return host.includes("jobup") ? "/en/jobs/" : "/en/vacancies/";
}

// The SERP carries exactly one ld+json <script>, holding an array of schema.org objects.
// The one we want is the ItemList; the others are WebSite/CollectionPage/BreadcrumbList.
function parseJobsChSerp(html) {
  const block = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (!block) return [];
  let parsed;
  try {
    parsed = JSON.parse(block[1]);
  } catch {
    return [];
  }
  const list = (Array.isArray(parsed) ? parsed : [parsed]).find((o) => o?.["@type"] === "ItemList");
  return (list?.itemListElement ?? [])
    .map((e) => e?.item)
    .filter((it) => it?.["@type"] === "JobPosting");
}

// The search state embedded in the page carries the real page count next to its hash.
// Other "numPages" keys on the page belong to unrelated widgets and read 0 or 1.
function parseJobsChNumPages(html) {
  const m = html.match(/"numPages":(\d+),"searchHash"/);
  return m ? Number(m[1]) : 0;
}

// Always name the country. These boards list Swiss towns in their local spelling
// ("Genf", "Baden", "Cham", "Carouge") and a town-name allow-list can never be complete:
// across the full IT category it rejected 514 of 815 title-passing rows (2026-09-28). Every posting carries a
// country code, and "Switzerland" is what the location filter actually needs.
function jobsChLocation(city, canton, countryCode) {
  const country = COUNTRY_NAMES[countryCode] || countryCode || "";
  const place = [city, canton ? `(${canton})` : ""].filter(Boolean).join(" ");
  return [place, country].filter(Boolean).join(", ");
}

async function fetchJobsCh(source, filters) {
  const host = source.host || "www.jobs.ch";
  const path = source.searchPath || jobsChSearchPath(host);
  const queries = source.queries ?? [];
  const categories = source.categories ?? [];
  const byId = new Map();
  let firstError = null;
  let serpFailures = 0;

  async function serpPage(params, page) {
    const url = `https://${host}${path}?${params}&page=${page}`;
    let res = await getText(url);
    if (res.error) res = await getText(url);   // one retry: a lost page is up to 20 lost rows
    if (res.error) {
      serpFailures++;
      if (byId.size === 0) firstError = res.error;
      return { posts: [], numPages: 0 };
    }
    return { posts: parseJobsChSerp(res.data), numPages: parseJobsChNumPages(res.data) };
  }

  function absorb(posts) {
    for (const p of posts) {
      const id = p.identifier?.value || (p.url || "").match(/detail\/([0-9a-f-]{30,})/)?.[1];
      if (!id || byId.has(id)) continue;
      const addr = p.jobLocation?.address ?? {};
      byId.set(id, {
        role: p.title,
        location: jobsChLocation(addr.addressLocality, "", addr.addressCountry || "CH"),
        internalId: String(id),
        // Canonical detail URL the site itself links to.
        link: p.url || `https://${host}${path}detail/${id}/`,
        description: "",
        company: p.hiringOrganization?.name || "",
        languageSkills: [],
        postedAt: (p.datePosted || "").slice(0, 10),
        sourceType: "aggregator"
      });
    }
  }

  // Page 1 of every listing first (it reports the page count), then every remaining
  // page through one shared pool.
  const listings = [
    ...categories.map((c) => ({ params: `category=${encodeURIComponent(c)}`, cap: JOBSCH_CATEGORY_MAX_PAGES })),
    ...queries.map((q) => ({ params: `term=${encodeURIComponent(q)}`, cap: JOBSCH_QUERY_PAGES }))
  ];
  const firstPages = await Promise.all(listings.map((l) => serpPage(l.params, 1)));
  const rest = [];
  listings.forEach((l, i) => {
    absorb(firstPages[i].posts);
    const last = Math.min(l.cap, firstPages[i].numPages);
    for (let page = 2; page <= last; page++) rest.push({ params: l.params, page });
  });
  let nextPage = 0;
  await Promise.all(
    Array.from({ length: Math.min(JOBSCH_SERP_CONCURRENCY, rest.length) }, async () => {
      while (nextPage < rest.length) {
        const { params, page } = rest[nextPage++];
        absorb((await serpPage(params, page)).posts);
      }
    })
  );
  if (firstError && byId.size === 0) return { error: firstError };

  // Enrich every row that could survive the title filter. Order by how promising the
  // title looks, then by date, so if the ceiling is ever reached it cuts the weakest
  // rows rather than the oldest.
  const rows = [...byId.values()];
  const promise = (r) => Number(RE_DEV_FIRST.test(r.role)) * 2 + Number(RE_SENIORITY.test(r.role));
  const passing = (filters ? rows.filter((r) => titleAllowed(r.role, filters)) : rows)
    .sort((a, b) => promise(b) - promise(a) || String(b.postedAt).localeCompare(String(a.postedAt)));
  const wanted = passing.slice(0, JOBSCH_MAX_DETAILS);
  let detailFailures = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(JOBSCH_DETAIL_CONCURRENCY, wanted.length) }, async () => {
      while (next < wanted.length) {
        const row = wanted[next++];
        const url = `https://${host}/api/v1/public/search/job/${row.internalId}`;
        let res = await getJson(url);
        if (res.error) res = await getJson(url);
        const { data, error } = res;
        if (error || !data) {
          detailFailures++;
          continue;
        }
        if (data.is_active === false) {
          byId.delete(row.internalId);
          continue;
        }
        row.description = htmlToText(data.template_text || "");
        // Rows whose listing omitted the city (a quarter of the IT category) get it here.
        const loc = Array.isArray(data.locations) ? data.locations[0] : null;
        row.location = loc
          ? jobsChLocation(loc.city || data.place, loc.cantonCode, loc.countryCode || "CH")
          : data.place ? jobsChLocation(data.place, "", "CH") : row.location;
        row.company = data.company_name || row.company;
        // Structured requirement — feeds the language-bar tag without reading the ad.
        if (Array.isArray(data.language_skills)) row.languageSkills = data.language_skills;
        // The employer's own apply URL. Aggregator rows are logged UNVERIFIED precisely
        // because they lack one; when jobs.ch exposes it, carry it so the agent can
        // resolve the employer-site link instead of filing another verification gap.
        const employer = data.application_url || data.external_url || "";
        if (employer && !employer.includes(host)) row.employerLink = employer;
      }
    })
  );
  // Partial losses are not errors (the rows that did arrive are real), but they must be
  // visible in the log — a silent gap is how this adapter lost half its coverage.
  const gaps = [
    serpFailures && `${serpFailures} listing page(s) failed`,
    detailFailures && `${detailFailures} row(s) without description`,
    passing.length > JOBSCH_MAX_DETAILS && `detail cap ${JOBSCH_MAX_DETAILS} reached (${passing.length} rows)`
  ].filter(Boolean);
  return { jobs: [...byId.values()], ...(gaps.length ? { warning: gaps.join("; ") } : {}) };
}

const providers = {
  greenhouse: (s) => fetchGreenhouse(s.slug),
  lever: (s) => fetchLever(s.slug),
  ashby: (s) => fetchAshby(s.slug),
  smartrecruiters: (s) => fetchSmartRecruiters(s.slug),
  workday: (s, f) => fetchWorkday(s, f),
  google: (s) => fetchGoogle(s),
  successfactors: (s) => fetchSuccessFactors(s),
  goldman: (s) => fetchGoldman(s),
  jobsch: (s, f) => fetchJobsCh(s, f)
};

// Exclusions match at a WORD START, not anywhere in the string. Plain `includes`
// made "ios" delete "Studios"/"Scenarios", "store" delete "Feature Store", and
// "mobile" delete "Automobile" — silently dropping exactly the platform titles worth
// having. Anchoring the start while leaving the end open keeps deliberate stems
// working ("merchandis" still catches "Merchandising").
const excludeCache = new Map();
function excludeRe(term) {
  let re = excludeCache.get(term);
  if (!re) {
    re = new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu");
    excludeCache.set(term, re);
  }
  return re;
}

// Title half of the filter, split out so the Workday adapter can ask "is this title
// worth a detail fetch?" before spending a request resolving its location.
function titleAllowed(role, { titleIncludes, titleExcludes }) {
  const title = String(role || "").toLowerCase();
  if (!title) return false;
  const titleOk = titleIncludes.length === 0 || titleIncludes.some((t) => title.includes(t));
  const excluded = (titleExcludes ?? []).some((t) => excludeRe(t).test(title));
  return titleOk && !excluded;
}

// Location terms are anchored at a word start for the same reason. The bare
// substring "gland" (a Swiss town near Geneva) matched "England, United Kingdom",
// so London roles were harvested AND sorted into the primary-region block the
// agents are told to work first. Terms starting with punctuation — ", ch", "(ch)"
// — are country-code suffixes and must stay plain substrings.
const locCache = new Map();
function locationMatches(loc, terms) {
  return terms.some((t) => {
    // ", ch" is a trailing country code ("Zurich, CH"). As a plain substring it also
    // matched "Shanghai, China" and would match ", Chicago"/", Charlotte", so it is
    // only honoured at the end of the string.
    if (t.startsWith(",")) return loc.trimEnd().endsWith(t);
    if (!/^[\p{L}\p{N}]/u.test(t)) return loc.includes(t);
    let re = locCache.get(t);
    if (!re) {
      re = new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "iu");
      locCache.set(t, re);
    }
    return re.test(loc);
  });
}

function matches(job, filters) {
  const loc = String(job.location || "").toLowerCase();
  const locOk = filters.locationFilters.length === 0 || locationMatches(loc, filters.locationFilters);
  return locOk && titleAllowed(job.role, filters);
}

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  // variant -> canonical, both sides normalized with aliases disabled (map is empty here).
  COMPANY_ALIASES = new Map(
    Object.entries(config.companyAliases ?? {}).map(([variant, canonical]) => [
      normalizeCompany(variant),
      normalizeCompany(canonical)
    ])
  );
  const filters = {
    locationFilters: (config.locationFilters ?? []).map((s) => s.toLowerCase()),
    titleIncludes: (config.titleIncludes ?? []).map((s) => s.toLowerCase()),
    titleExcludes: (config.titleExcludes ?? []).map((s) => s.toLowerCase())
  };

  // Sources are fetched with bounded concurrency — the work is almost entirely
  // network wait, and paging the big Workday boards serially took minutes. Results
  // are written back by index so the output order stays identical to the config
  // order regardless of which source finishes first.
  const sources = config.sources ?? [];
  const perSource = new Array(sources.length);

  async function runSource(source, index) {
    const provider = providers[source.provider];
    if (!provider) {
      perSource[index] = { report: { ...source, fetched: 0, kept: 0, error: "unknown provider" }, candidates: [] };
      return;
    }
    // A source may widen its own location scope (currently the current employer, kept
    // Europe-wide). Whether those rows are IN SCOPE is a per-run decision the agent
    // makes from the run's employer-Europe option — so the harvester must not
    // pre-filter them away to the default region, or the option would have nothing
    // left to reveal. They sort after the primary region and carry a scopeNote.
    const wider = Array.isArray(source.locationFilters) && source.locationFilters.length > 0;
    const sourceFilters = wider
      ? { ...filters, locationFilters: source.locationFilters.map((s) => s.toLowerCase()) }
      : filters;
    const { jobs, error, warning } = await provider(source, sourceFilters);
    if (error) {
      perSource[index] = { report: { ...source, fetched: 0, kept: 0, error }, candidates: [] };
      return;
    }
    const kept = jobs.filter((j) => matches(j, sourceFilters));
    perSource[index] = {
      candidates: kept.map((j) => ({
        // Aggregator rows carry their own employer; ATS rows take it from the source.
        company: j.company || source.company,
        provider: source.provider,
        ...(j.sourceType ? { sourceType: j.sourceType } : {}),
        ...(j.postedAt ? { postedAt: j.postedAt } : {}),
        ...(j.languageSkills?.length ? { languageSkills: j.languageSkills } : {}),
        role: j.role,
        location: j.location,
        internalId: j.internalId,
        link: j.link,
        // Aggregator rows only: the employer's own apply URL when the board exposes it,
        // so the UNVERIFIED board link can be upgraded without a separate hunt.
        ...(j.employerLink ? { employerLink: j.employerLink } : {}),
        // Full JD text (Greenhouse/Lever/Ashby) so agents can score/verify/write
        // cover letters without web fetches. Empty for sources that don't expose it.
        description: j.description || "",
        comp: j.comp || "",
        ...(wider
          ? { scopeNote: "Wider-than-default location scope (employer-wide). In scope only when this run enables the employer-Europe option; otherwise skip." }
          : {})
      })),
      // Record EVERY fetched requisition id, not just the kept ones. A tracked role
      // that is absent from `candidates[]` but present here was filtered out (wrong
      // city/title), NOT closed — reading filtered-absence as closure has repeatedly
      // caused live roles to be archived by mistake.
      report: {
        company: source.company,
        provider: source.provider,
        fetched: jobs.length,
        kept: kept.length,
        ...(warning ? { warning } : {}),
        allInternalIds: jobs.map((j) => String(j.internalId || "")).filter(Boolean)
      }
    };
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SOURCE_CONCURRENCY, sources.length) }, async () => {
      while (next < sources.length) {
        const index = next++;
        await runSource(sources[index], index);
      }
    })
  );

  const candidates = perSource.flatMap((s) => s.candidates);
  const sourceReport = perSource.map((s) => s.report);

  // Dedupe within this harvest.
  //  1. Same posting: same link, or same employer + requisition id. jobs.ch and jobup.ch
  //     share ids for a cross-posted ad, so this collapses the two boards' copies.
  //  2. An aggregator copy of a posting we already pull from the employer's own ATS: same
  //     employer (legal-entity names normalised) + same title. The employer-direct row
  //     wins because it carries the real apply link.
  // Title matching is ONLY used for (2). Two direct rows, or two board rows, with the
  // same title but different ids are different postings — Salesforce's Zurich and Munich
  // "Senior Forward Deployed Engineer", Pictet's two "Software Engineer" ads — and the
  // old company+title key silently kept one and hid the other.
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const keys = [c.link, candidateKey(c)].filter(Boolean);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    unique.push(c);
  }
  const titleIdentity = (c) =>
    `${normalizeCompany(c.company)}|${String(c.role || "").toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
  const directTitles = new Set(unique.filter((c) => c.sourceType !== "aggregator").map(titleIdentity));
  // The boards also re-post one ad under a second id (jobs.ch + jobup.ch, or a refresh).
  // Among BOARD rows only, same employer + title + town is the same job.
  const boardTown = (c) => foldDiacritics(String(c.location || "").toLowerCase()).split(/[,(]/)[0].trim();
  const boardSeen = new Set();
  const deduped = unique.filter((c) => {
    if (c.sourceType !== "aggregator") return true;
    if (directTitles.has(titleIdentity(c))) return false;
    const k = `${titleIdentity(c)}|${boardTown(c)}`;
    if (boardSeen.has(k)) return false;
    boardSeen.add(k);
    return true;
  });

  // Primary-region-first ordering. `primaryLocationFilters` (config) names the
  // candidate's top-tier target region; everything else in `locationFilters` is the
  // backup tier. Sorting here means agents curating top-down exhaust the primary
  // region before spending budget on the backup tier. Candidate-agnostic: the terms
  // live in ats_sources.json, never in this file.
  const primaryFilters = (config.primaryLocationFilters ?? []).map((s) => s.toLowerCase());
  const isPrimary = (c) => locationMatches(String(c.location || "").toLowerCase(), primaryFilters);

  // Carry `firstSeen` across harvests and mark what is genuinely new. Without this the
  // file looks identical every run and an agent has no way to tell a posting it already
  // rejected last week from one that appeared this morning.
  const previous = await readJsonSafe(outPath, { candidates: [] });
  const firstSeenByKey = new Map();
  const previousByKey = new Map();
  for (const c of previous.candidates ?? []) {
    if (c.firstSeen) firstSeenByKey.set(candidateKey(c), c.firstSeen);
    previousByKey.set(candidateKey(c), c);
  }
  // Verdicts agents already reached. Stamped onto the row so the prompt can say
  // "skip what you have already rejected unless it changed".
  const decisions = await readJsonSafe(decisionsPath, {});
  const today = new Date().toISOString().slice(0, 10);
  const consultancyKeys = new Set((config.consultancyEmployers ?? []).map(normalizeCompany));

  let newCount = 0;
  let reopenedCount = 0;
  for (const c of deduped) {
    const key = candidateKey(c);
    c.key = key;
    c.firstSeen = firstSeenByKey.get(key) ?? today;
    c.isNew = !firstSeenByKey.has(key);
    if (c.isNew) newCount++;
    const prior = decisions[key];
    if (prior) {
      c.priorVerdict = prior.verdict;
      if (prior.reason) c.priorReason = prior.reason;
      if (prior.roleId) c.priorRoleId = prior.roleId;
      if (prior.date) c.priorDate = prior.date;
      // How much ad text the deciding agent had: carried forward while the decision
      // stands, otherwise taken from the harvest that decision was made on (the previous
      // file). A rejection reached on a title and an empty description is not a verdict
      // on the job, and "never re-litigate a REJECTED row" turned it into a permanent
      // one — 107 rows on 2026-09-27. Reopen it once the full ad has arrived.
      const prev = previousByKey.get(key);
      c.decidedDescLen = prev?.priorDate === prior.date && Number.isFinite(prev?.decidedDescLen)
        ? prev.decidedDescLen
        : String((prev ?? c).description || "").length;
      if (prior.verdict === "REJECTED" && c.decidedDescLen < THIN_JD && String(c.description || "").length >= THIN_JD) {
        c.priorVerdict = "REOPENED";
        c.reopenReason = "rejected without the job description, which is now available";
        reopenedCount++;
      }
    }
    // Tag on the FULL description, before the region clamp truncates it.
    const { tags, fitScore } = tagCandidate(c, consultancyKeys);
    if (tags.length) c.tags = tags;
    c.fitScore = fitScore + (c.isNew || c.priorVerdict === "REOPENED" ? 1 : 0);
    delete c.languageSkills; // structured input to the tags; no need to ship it onward
  }

  // Primary region still dominates the ordering; fitScore only breaks ties within a
  // tier, so the developer-first rows rise above the ops/consultancy volume instead of
  // being buried by source order. Nothing is removed — this is purely a queue order.
  const ordered = [...deduped].sort((a, b) =>
    (primaryFilters.length ? Number(isPrimary(b)) - Number(isPrimary(a)) : 0)
    || b.fitScore - a.fitScore
    || Number(b.isNew) - Number(a.isNew)
  );
  const primaryCount = primaryFilters.length ? ordered.filter(isPrimary).length : 0;

  // Clamp descriptions only now that primary/backup is known, so top-region rows keep
  // more of their text than the backup tier.
  for (const c of ordered) {
    c.description = clampJd(c.description, isPrimary(c) ? JD_PRIMARY_MAX : JD_BACKUP_MAX);
  }

  const out = {
    meta: {
      fetchedAt: new Date().toISOString(),
      sourceCount: (config.sources ?? []).length,
      candidateCount: ordered.length,
      primaryCount,
      newCount,
      reopenedCount,
      undecidedCount: ordered.filter((c) => !c.priorVerdict || c.priorVerdict === "REOPENED").length,
      note: "Live ATS-API candidates for the search agent to curate (rubric/dedupe/salary). Not yet filtered against roles[] — cross-check before logging. Sorted PRIMARY-REGION-FIRST (see primaryLocationFilters in ats_sources.json): the first `primaryCount` entries are in the candidate's top-tier target region; work those to exhaustion before the backup tier. `sourceReport[].allInternalIds` lists every requisition id fetched per source — an id present there but absent from candidates[] was FILTERED OUT (wrong city/title), NOT closed; do not archive on that basis. `description` keeps the START and the END of the job ad; a long one has its MIDDLE replaced by '[… middle of description elided …]'. The end is preserved deliberately, because required years, language demands and work-authorization notes live there — so judge level/language/permit from the text AFTER the marker, and treat the marker as elided boilerplate, not as a missing requirement. TRIAGE ORDER: rows are sorted primary-region first, then by `fitScore`. `isNew` marks postings not present in the previous harvest and `newCount` counts them — work those FIRST. `priorVerdict`/`priorReason` carry a decision an agent already recorded in tracking/candidate_decisions.json: do NOT re-litigate a REJECTED row unless its title or description changed, and append your own new rejections to that file keyed by `key`. `priorVerdict: \"REOPENED\"` (see `reopenReason`, counted by `reopenedCount`) means an earlier rejection was made without the job description and the full ad has since arrived — triage it exactly like an isNew row. `undecidedCount` is the size of the queue that still needs a verdict. `tags` are deterministic hints, not verdicts — `developer-first`, `senior`, `ops-shaped`, `consultancy`, `language-bar` (German/French required), `contract` (external payroll), `weak-language` (C++/C#), `aggregator`. They rank the queue; the rubric still decides. `aggregator` rows come from a job board rather than an employer ATS: log them with linkStatus UNVERIFIED and a statusNote saying the employer-site link is unresolved, then upgrade the link when you find the employer's own posting."
    },
    sourceReport,
    candidates: ordered
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

  const ok = sourceReport.filter((s) => !s.error).length;
  console.log(
    `ATS harvest: ${ordered.length} candidates (${primaryCount} in primary region, listed first) from ${ok}/${sourceReport.length} sources -> tracking/ats_candidates.json`
  );
  if (reopenedCount) console.log(`  ${reopenedCount} earlier rejection(s) reopened: decided without a JD, full ad now available`);
  // A board that returned postings last run and none now has almost always moved ATS
  // or changed its API (Frontify: Lever -> Ashby) — it reports 0/0 with no error.
  const previouslyFetched = new Map((previous.sourceReport ?? []).map((s) => [`${s.company}|${s.provider}`, s.fetched]));
  for (const s of sourceReport) {
    const before = previouslyFetched.get(`${s.company}|${s.provider}`);
    const dropped = !s.error && s.fetched === 0 && before > 0 ? ` ⚠ fetched ${before} last run — board moved or API changed?` : "";
    const warn = s.warning ? ` ⚠ ${s.warning}` : "";
    console.log(`  ${s.error ? "✗" : "✓"} ${s.company} (${s.provider}): ${s.error ? s.error : `${s.kept}/${s.fetched} kept`}${dropped}${warn}`);
  }
}

main().catch((err) => {
  console.error("fetch_ats failed:", err.message);
  process.exit(1);
});
