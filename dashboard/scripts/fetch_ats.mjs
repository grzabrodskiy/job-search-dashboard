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

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 25000; // higher: Greenhouse content=true returns large payloads
const JD_MAX = 2800; // cap stored job-description text so the candidate file stays reasonable

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
const WORKDAY_PAGE = 20;
const WORKDAY_MAX_PAGES = 20;
const WORKDAY_DETAIL_BATCH = 6;
async function fetchWorkday(source) {
  const { slug, host } = source;
  if (!host) return { error: "workday source needs a host" };
  const site = slug.split("/")[1] ?? "";
  const url = `https://${host}/wday/cxs/${slug}/jobs`;
  const queries = source.queries ?? [""];
  const byPath = new Map();
  let firstError = null;
  for (const q of queries) {
    for (let page = 0; page < WORKDAY_MAX_PAGES; page++) {
      const { data, error } = await getJson(url, {
        method: "POST",
        body: { appliedFacets: {}, limit: WORKDAY_PAGE, offset: page * WORKDAY_PAGE, searchText: q }
      });
      if (error) {
        if (page === 0 && byPath.size === 0) firstError = error;
        break;
      }
      const postings = data.jobPostings ?? [];
      for (const j of postings) {
        const path = j.externalPath ?? `${j.title}-${j.bulletFields?.[0] ?? ""}`;
        if (byPath.has(path)) continue;
        byPath.set(path, {
          role: j.title,
          location: j.locationsText ?? "",
          internalId: String(j.bulletFields?.[0] ?? ""),
          link: `https://${host}/en-US/${site}${j.externalPath ?? ""}`,
          path: j.externalPath ?? ""
        });
      }
      if (postings.length < WORKDAY_PAGE || page * WORKDAY_PAGE + postings.length >= (data.total ?? 0)) break;
    }
  }
  if (firstError) return { error: firstError };

  // The list endpoint omits the JD. Hydrate target-region rows from the CXS detail
  // endpoint, which also returns `canApply` — a first-class liveness signal that is
  // more reliable than inferring closure from harvest absence.
  const jobs = [...byPath.values()];
  const wanted = jobs.filter((j) => SR_LOC_HINTS.some((h) => j.location.toLowerCase().includes(h)));
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
async function fetchGoogle(source) {
  const locations = source.locations ?? ["Zurich, Switzerland"];
  const queries = source.queries ?? ["software engineer"];
  // Phase 1: scrape listing pages to collect (id, slug, location) triples
  const byId = new Map();
  for (const loc of locations) {
    for (const q of queries) {
      const url =
        "https://www.google.com/about/careers/applications/jobs/results/" +
        `?location=${encodeURIComponent(loc)}&q=${encodeURIComponent(q)}`;
      const { data, error } = await getText(url);
      if (error) continue;
      const re = /jobs\/results\/(\d{6,})-([a-z0-9-]+)/g;
      let m;
      while ((m = re.exec(data)) !== null) {
        const [, id, slug] = m;
        if (!byId.has(id)) byId.set(id, { id, slug, location: loc });
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

const providers = {
  greenhouse: (s) => fetchGreenhouse(s.slug),
  lever: (s) => fetchLever(s.slug),
  ashby: (s) => fetchAshby(s.slug),
  smartrecruiters: (s) => fetchSmartRecruiters(s.slug),
  workday: (s) => fetchWorkday(s),
  google: (s) => fetchGoogle(s),
  successfactors: (s) => fetchSuccessFactors(s)
};

function matches(job, { locationFilters, titleIncludes, titleExcludes }) {
  const loc = String(job.location || "").toLowerCase();
  const title = String(job.role || "").toLowerCase();
  if (!title) return false;
  const locOk = locationFilters.length === 0 || locationFilters.some((f) => loc.includes(f));
  const titleOk = titleIncludes.length === 0 || titleIncludes.some((t) => title.includes(t));
  const excluded = (titleExcludes ?? []).some((t) => title.includes(t));
  return locOk && titleOk && !excluded;
}

async function main() {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const filters = {
    locationFilters: (config.locationFilters ?? []).map((s) => s.toLowerCase()),
    titleIncludes: (config.titleIncludes ?? []).map((s) => s.toLowerCase()),
    titleExcludes: (config.titleExcludes ?? []).map((s) => s.toLowerCase())
  };

  const candidates = [];
  const sourceReport = [];

  for (const source of config.sources ?? []) {
    const provider = providers[source.provider];
    if (!provider) {
      sourceReport.push({ ...source, fetched: 0, kept: 0, error: "unknown provider" });
      continue;
    }
    const { jobs, error } = await provider(source);
    if (error) {
      sourceReport.push({ ...source, fetched: 0, kept: 0, error });
      continue;
    }
    const kept = jobs.filter((j) => matches(j, filters));
    for (const j of kept) {
      candidates.push({
        company: source.company,
        provider: source.provider,
        role: j.role,
        location: j.location,
        internalId: j.internalId,
        link: j.link,
        // Full JD text (Greenhouse/Lever/Ashby) so agents can score/verify/write
        // cover letters without web fetches. Empty for sources that don't expose it.
        description: j.description || "",
        comp: j.comp || ""
      });
    }
    // Record EVERY fetched requisition id, not just the kept ones. A tracked role
    // that is absent from `candidates[]` but present here was filtered out (wrong
    // city/title), NOT closed — reading filtered-absence as closure has repeatedly
    // caused live roles to be archived by mistake.
    sourceReport.push({
      company: source.company,
      provider: source.provider,
      fetched: jobs.length,
      kept: kept.length,
      allInternalIds: jobs.map((j) => String(j.internalId || "")).filter(Boolean)
    });
  }

  // Dedupe within this harvest on link, else company+role+internalId.
  const seen = new Set();
  const deduped = candidates.filter((c) => {
    const key = c.link || `${c.company}|${c.role}|${c.internalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Primary-region-first ordering. `primaryLocationFilters` (config) names the
  // candidate's top-tier target region; everything else in `locationFilters` is the
  // backup tier. Sorting here means agents curating top-down exhaust the primary
  // region before spending budget on the backup tier. Candidate-agnostic: the terms
  // live in ats_sources.json, never in this file.
  const primaryFilters = (config.primaryLocationFilters ?? []).map((s) => s.toLowerCase());
  const isPrimary = (c) => {
    const loc = String(c.location || "").toLowerCase();
    return primaryFilters.some((f) => loc.includes(f));
  };
  const ordered = primaryFilters.length
    ? [...deduped].sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)))
    : deduped;
  const primaryCount = primaryFilters.length ? ordered.filter(isPrimary).length : 0;

  const out = {
    meta: {
      fetchedAt: new Date().toISOString(),
      sourceCount: (config.sources ?? []).length,
      candidateCount: ordered.length,
      primaryCount,
      note: "Live ATS-API candidates for the search agent to curate (rubric/dedupe/salary). Not yet filtered against roles[] — cross-check before logging. Sorted PRIMARY-REGION-FIRST (see primaryLocationFilters in ats_sources.json): the first `primaryCount` entries are in the candidate's top-tier target region; work those to exhaustion before the backup tier. `sourceReport[].allInternalIds` lists every requisition id fetched per source — an id present there but absent from candidates[] was FILTERED OUT (wrong city/title), NOT closed; do not archive on that basis."
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
  for (const s of sourceReport) {
    console.log(`  ${s.error ? "✗" : "✓"} ${s.company} (${s.provider}): ${s.error ? s.error : `${s.kept}/${s.fetched} kept`}`);
  }
}

main().catch((err) => {
  console.error("fetch_ats failed:", err.message);
  process.exit(1);
});
