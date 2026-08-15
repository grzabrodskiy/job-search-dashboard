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
const SOURCE_CONCURRENCY = 5; // sources fetched in parallel; the work is network-bound
// Job-description text. Adapters keep a generous amount at fetch time; main() then
// clamps each row to a region-aware budget so the candidate file stays reasonable.
// Primary-region rows get the larger budget — those are the ones agents actually
// score in detail.
const JD_MAX = 20000; // fetch-time ceiling, guards against pathological pages
const JD_PRIMARY_MAX = 5000;
const JD_BACKUP_MAX = 2800;
const JD_ELISION = "\n\n[… middle of description elided …]\n\n";

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

const providers = {
  greenhouse: (s) => fetchGreenhouse(s.slug),
  lever: (s) => fetchLever(s.slug),
  ashby: (s) => fetchAshby(s.slug),
  smartrecruiters: (s) => fetchSmartRecruiters(s.slug),
  workday: (s, f) => fetchWorkday(s, f),
  google: (s) => fetchGoogle(s),
  successfactors: (s) => fetchSuccessFactors(s),
  goldman: (s) => fetchGoldman(s)
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
    const { jobs, error } = await provider(source, sourceFilters);
    if (error) {
      perSource[index] = { report: { ...source, fetched: 0, kept: 0, error }, candidates: [] };
      return;
    }
    const kept = jobs.filter((j) => matches(j, sourceFilters));
    perSource[index] = {
      candidates: kept.map((j) => ({
        company: source.company,
        provider: source.provider,
        role: j.role,
        location: j.location,
        internalId: j.internalId,
        link: j.link,
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
  const isPrimary = (c) => locationMatches(String(c.location || "").toLowerCase(), primaryFilters);
  const ordered = primaryFilters.length
    ? [...deduped].sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)))
    : deduped;
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
      note: "Live ATS-API candidates for the search agent to curate (rubric/dedupe/salary). Not yet filtered against roles[] — cross-check before logging. Sorted PRIMARY-REGION-FIRST (see primaryLocationFilters in ats_sources.json): the first `primaryCount` entries are in the candidate's top-tier target region; work those to exhaustion before the backup tier. `sourceReport[].allInternalIds` lists every requisition id fetched per source — an id present there but absent from candidates[] was FILTERED OUT (wrong city/title), NOT closed; do not archive on that basis. `description` keeps the START and the END of the job ad; a long one has its MIDDLE replaced by '[… middle of description elided …]'. The end is preserved deliberately, because required years, language demands and work-authorization notes live there — so judge level/language/permit from the text AFTER the marker, and treat the marker as elided boilerplate, not as a missing requirement."
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
