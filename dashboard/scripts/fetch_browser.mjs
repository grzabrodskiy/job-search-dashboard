#!/usr/bin/env node
// Headless-browser harvester for BOT-BLOCKED employers (UBS, Swiss Re, Zurich
// Insurance) whose own career sites and ATS APIs refuse plain HTTP. For each
// employer it tries the DIRECT site first; if that yields nothing it falls back
// to the jobs.ch AGGREGATOR filtered to that exact company. Aggregator results
// are clearly marked (aggregator:true, linkStatus SEARCH, a verify note) per the
// family rule: direct first, aggregator only as fallback, always labelled.
//
// Appends/merges into tracking/ats_candidates.json (same file fetch_ats.mjs writes),
// so the search agents see one combined candidate list. Run after fetch_ats.mjs.
// Usage: node dashboard/scripts/fetch_browser.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..");
const atsConfigPath = resolve(__dirname, "ats_sources.json");
const browserConfigPath = resolve(__dirname, "browser_sources.json");
const outPath = resolve(root, "tracking/ats_candidates.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DIRECT_MIN = 3; // direct attempt counts as success only with this many distinct job links

function matches(job, { locationFilters, titleIncludes, titleExcludes }) {
  const loc = String(job.location || "").toLowerCase();
  const title = String(job.role || "").toLowerCase();
  if (!title) return false;
  const locOk = locationFilters.length === 0 || locationFilters.some((f) => loc.includes(f));
  const titleOk = titleIncludes.length === 0 || titleIncludes.some((t) => title.includes(t));
  const excluded = (titleExcludes ?? []).some((t) => title.includes(t));
  return locOk && titleOk && !excluded;
}

// Try the employer's own site in a real browser. Returns job links if the page
// renders real postings; an empty list means it is blocked/empty -> fall back.
async function tryDirect(page, source) {
  const { url, jobLinkPattern } = source.direct ?? {};
  if (!url) return [];
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);
    const re = new RegExp(jobLinkPattern, "i");
    const links = await page.$$eval("a[href]", (as) =>
      as.map((a) => ({ href: a.href, text: (a.textContent || "").trim() }))
    );
    const seen = new Set();
    const jobs = [];
    for (const l of links) {
      if (!re.test(l.href) || seen.has(l.href)) continue;
      seen.add(l.href);
      jobs.push({ role: l.text || "(see posting)", location: "", internalId: "", link: l.href });
    }
    return jobs;
  } catch {
    return [];
  }
}

// jobs.ch fallback: drive the search page and parse the rendered result cards.
// jobs.ch renders results server-side (its JSON API host is auth-walled), so we
// read the DOM. Each card exposes the job id via a `serp-item-<id>` data-cy and a
// structured text block ("Place of work: … Workload: … Contract type: <type> <Company> …")
// from which we parse company/location precisely, then keep ONLY the target employer
// (precise companyMatch) — fuzzy jobs.ch keyword hits are dropped, not emitted as noise.
async function tryAggregator(page, source) {
  const { term, locations = [""], companyMatch } = source.aggregator ?? {};
  if (!term) return [];
  const companyRe = companyMatch ? new RegExp(companyMatch, "i") : null;

  const byId = new Map();
  for (const loc of locations) {
    const url =
      "https://www.jobs.ch/en/vacancies/?" +
      `term=${encodeURIComponent(term)}` +
      (loc ? `&location=${encodeURIComponent(loc)}` : "");
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 35000 });
      await page.waitForTimeout(2500);
    } catch {
      continue;
    }
    const cards = await page.$$eval("[data-cy='vacancy-serp-item']", (nodes) =>
      nodes.map((card) => {
        const idEl = [...card.querySelectorAll("[data-cy]")].find((e) =>
          (e.getAttribute("data-cy") || "").startsWith("serp-item-")
        );
        const id = idEl ? idEl.getAttribute("data-cy").replace("serp-item-", "") : "";
        const link = card.querySelector("a[href*='/vacancies/detail/']")?.href || "";
        const text = (card.innerText || "").replace(/\s+/g, " ").trim();
        return { id, link, text };
      })
    );
    for (const c of cards) {
      const id = c.id || c.link;
      if (!id || byId.has(id)) continue;
      // Parse the structured card text.
      const locM = c.text.match(/Place of work:\s*(.+?)\s*(?:Workload:|Contract type:|$)/i);
      const compM = c.text.match(
        /Contract type:\s*(?:Permanent position|Temporary(?: position)?|Apprenticeship|Internship|Freelance|Contract|Part[- ]time)\s+(.+?)\s*(?:Easy apply|Is this job relevant|Promoted|Quick apply|$)/i
      );
      // Title = text before "Place of work:", minus the leading "<age>" phrase.
      const titleM = c.text.split(/\s*Place of work:/i)[0]
        .replace(/^(?:\d+\s+\w+\s+ago|Yesterday|Today|Last week|Last month|Last quarter|This week|Promoted)\s*/i, "")
        .trim();
      byId.set(id, {
        role: titleM,
        location: locM ? locM[1].trim() : "",
        company: compM ? compM[1].trim() : "",
        internalId: c.id || "",
        link: c.link
      });
    }
  }

  const jobs = [];
  for (const j of byId.values()) {
    // Keep only genuine postings from the target employer (drop fuzzy keyword hits).
    if (companyRe && !companyRe.test(j.company)) continue;
    if (!j.link) continue;
    jobs.push(j);
  }
  return jobs;
}

async function main() {
  const atsConfig = JSON.parse(await readFile(atsConfigPath, "utf8"));
  const browserConfig = JSON.parse(await readFile(browserConfigPath, "utf8"));
  const filters = {
    locationFilters: (atsConfig.locationFilters ?? []).map((s) => s.toLowerCase()),
    titleIncludes: (atsConfig.titleIncludes ?? []).map((s) => s.toLowerCase()),
    titleExcludes: (atsConfig.titleExcludes ?? []).map((s) => s.toLowerCase())
  };

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await ctx.newPage();

  const newCandidates = [];
  const report = [];

  for (const source of browserConfig.sources ?? []) {
    let mode = "direct";
    let jobs = await tryDirect(page, source);
    jobs = jobs.filter((j) => matches(j, filters));

    if (jobs.length < DIRECT_MIN) {
      mode = "aggregator";
      const agg = await tryAggregator(page, source);
      jobs = agg.filter((j) => matches(j, filters));
    }

    for (const j of jobs) {
      const aggregator = mode === "aggregator";
      newCandidates.push({
        company: source.company,
        provider: aggregator ? "jobs.ch (aggregator)" : "browser (direct)",
        role: j.role,
        location: j.location,
        internalId: j.internalId,
        link: j.link,
        aggregator,
        sourceNote: aggregator
          ? `via jobs.ch aggregator — ${source.company}'s own site is bot-blocked; verify on the employer's posting before applying`
          : `direct from ${source.company} career site via headless browser`
      });
    }
    report.push({ company: source.company, mode, kept: jobs.length });
  }

  await browser.close();

  // Merge into the existing ats_candidates.json (do not clobber the ATS-API harvest).
  let existing = { meta: {}, sourceReport: [], candidates: [] };
  try {
    existing = JSON.parse(await readFile(outPath, "utf8"));
  } catch {
    /* file may not exist yet */
  }
  const all = [...(existing.candidates ?? [])];
  const seen = new Set(all.map((c) => c.link || `${c.company}|${c.role}|${c.internalId}`));
  let added = 0;
  for (const c of newCandidates) {
    const key = c.link || `${c.company}|${c.role}|${c.internalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(c);
    added++;
  }

  const out = {
    meta: {
      ...(existing.meta ?? {}),
      browserFetchedAt: new Date().toISOString(),
      candidateCount: all.length
    },
    sourceReport: [...(existing.sourceReport ?? []), ...report.map((r) => ({ ...r, provider: "browser/jobs.ch" }))],
    candidates: all
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log(`Browser harvest: +${added} candidates (now ${all.length}) -> tracking/ats_candidates.json`);
  for (const r of report) console.log(`  ${r.company}: ${r.mode} -> ${r.kept} kept`);
}

main().catch((err) => {
  console.error("fetch_browser failed:", err.message);
  process.exit(1);
});
