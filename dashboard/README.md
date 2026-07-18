# Job Search Dashboard

Run from the repository root:

```sh
npm run dashboard
```

Then open:

```text
http://localhost:3000
```

## Data model

- `tracking/search_results.json` — the SINGLE source of truth. One `roles[]` array; each role has a permanent `id` (`R-####`, from `meta.nextId`). Job facts, peer review, priority, salary, link status, suitability notes, and the base `status` are agent-owned. The family edits only three things in the dashboard: the **Applied** checkbox (`userApplied`), the **Reject** checkbox (`userRejected`), and the **comment** (`comments`). All edits **auto-save** (no Save button). Every pipeline run automatically re-verifies all open roles (still live? still a fit?) and acts on each role's comment.
- `tracking/dashboard_requests.json` — action requests created by the `Run Claude` / `Run Codex` buttons and any older queued rows.
- `reports/search_results.md` — generated from the JSON (Best Jobs / Applications / All Roles / Gmail). Never hand-edited.

`tracking/leads.md` and `tracking/applications.md` are retired — everything lives in `roles[]`. An "application" is simply a role whose displayed status is `APPLIED`.

### Status (five, derived — read-only in the UI)

`NEW` (added by the latest search; the next search demotes prior NEW to OPEN) → `OPEN` (active candidate) → `APPLIED` (you ticked Applied, or recruiter evidence) → `DECLINED` (you ticked Reject, or the employer rejected) → `ARCHIVED` (closed, or 30+ days idle). The status pill is read-only; you move a role by ticking **Applied** or **Reject**. The agent sets the base status and writes the reason in the status note. `linkStatus`: `VERIFIED`, `DIRECT`, `SEARCH`, `UNVERIFIED`, `STALE`. Non-Swiss roles are flagged with an amber edge and amber location. Your comments are read by the search agents to improve future searches.

The dashboard saves the JSON and regenerates the markdown when you click **Save changes**.

## Views

- **Best jobs** — active roles (NEW/OPEN) ranked by priority + Swiss location + peer-review. The default landing view.
- **All roles** — everything, newest first.
- **Applications** — roles you've marked Applied.
- **Latest run** — holistic summary of the most recent run in four sections: **What changed** (jobs added, priorities shifted, archived/declined, email-driven status changes), **Issues & deficiencies from run logs** (failures, blocked sites, context/quota limits — read straight from the logs so even a crash that wrote no summary still shows), **Market overview**, and **Suggestions** to improve the process or search. Plus recent email updates and previous runs.
- **Activity** — agent run requests.

Filters (text search, status, peer-reviewed, sort, summary cards) appear only on the role views (Best jobs / All roles). Click a row's ▸ to expand its details (comp range, Pros/Cons, links, status note).

## Cover letters & form answers

Expand any role — there are two separate actions:

- **✉ Cover letter** — a standard cover letter; pick the length in paragraphs.
- **📝 Answer form questions** — for applications that ask specific questions (e.g. "biggest achievement", "why this company"). Add each question with its own paragraph length; each is answered and labelled.

Both let you add extra instructions, **Generate** (Claude tailors the text using the role's harvested job description), **edit the result inline**, then **Copy**, **💾 Save**, or **Download PDF** — all use your edited text. Nothing is written to disk until you click **Save**, which stores it under `cover_letters/` (`cover_letter_*` vs `answers_*`) for future reference.

## Run Claude / Run Codex (two independent buttons)

There are two buttons — **▶ Run Claude** and **▶ Run Codex**. Each runs that one agent as a **self-contained solo run**, completely independent of the other (so one agent's crash or quota limit never affects the other). Each run:

0. **ATS harvest** — `dashboard/scripts/fetch_ats.mjs` pulls live postings from employer ATS JSON APIs (Greenhouse/Lever/Ashby/SmartRecruiters/Workday) + Google Careers into `tracking/ats_candidates.json`. These APIs are **not bot-blocked** like rendered career pages (`WebFetch` gets HTTP 403 on Google/Lever/Ashby/etc.), so the agent starts from real, live leads. Each candidate also carries the **full job-description text** (`description`, from Greenhouse/Lever/Ashby) so agents score fit, detect language/comp, write pros/cons, and tailor cover letters **without web fetches**. Add employers to `dashboard/scripts/ats_sources.json` to widen coverage. (Log: `reports/agent_runs/<id>-harvest.log`.) Run manually with `npm run harvest`.
1. The agent updates statuses from email, curates the harvest into NEW roles, does limited gap-filling web search, **self-reviews** its own finds (no peer model in a solo run), and writes a holistic run summary.

The optional **focus instruction** entered when you click a button is a *priority directive* for that run — if it names companies/locations/role types, the agent narrows the run to them first.

**Why two buttons instead of one combined pipeline?** Since the ATS harvester now does discovery deterministically, both agents would otherwise curate the *same* list — near-duplicate work at double the cost and double the failure surface (a chained pipeline failed whenever *either* agent hit a context/quota limit). Independent buttons let you run whichever agent has credits, alternate, or compare.

   **Optional browser harvester (`npm run harvest:browser`, NOT wired into a run):** `dashboard/scripts/fetch_browser.mjs` (Playwright) handles employers whose own sites are bot-blocked — it tries the direct site, then falls back to the **jobs.ch** aggregator filtered to that exact company, marking aggregator results clearly (`aggregator:true`, verify note). Config: `dashboard/scripts/browser_sources.json`. NOTE: the three currently configured (UBS, Swiss Re, Zurich Insurance) yield ~0 because they don't syndicate to jobs.ch *and* their own sites are bot-walled — kept as scaffolding for future employers that do syndicate. For UBS/Swiss Re specifically, the robust route is employer job-alert emails forwarded to the monitored Gmail.

Runs write logs to `reports/agent_runs/`, and the Activity tab shows `RUNNING`, `COMPLETED`, or `FAILED` plus a log link. The **Latest run** tab also scans these logs and reports any failures/deficiencies (via `GET /api/run-health`), so a crash that prevented a summary still surfaces. These runs can consume Codex/Claude credits and depend on the local CLI profiles having the required tools configured.
