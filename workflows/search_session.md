# Shared Search Session Workflow

Use this workflow for every job-search run, regardless of whether the agent is Claude or Codex.
The candidate's profile, target roles/locations, language strengths, and sponsorship situation live
in `config/candidate.json` (`searchBrief`) — read it first; everything below is candidate-agnostic.

## Before Searching

0. **Co-recruiter sync (do this first):** Read `workflows/collaboration_protocol.md` and `memory/coordination_board.md`. Reserve a number block and post an "in progress" claim before editing trackers, so Claude and Codex do not collide.
1. Read `config/candidate.json` for the candidate profile, `searchBrief`, and constraints.
2. Read `CLAUDE.md` (and `AGENTS.md` if running in Codex).
3. Read `memory/README.md` and `memory/agent_memory.md`.
4. Read `tracking/search_results.json` (the SINGLE source of truth — one `roles[]` array) and `tracking/dashboard_requests.json` for user comments, status changes, and action requests. Dedupe against `roles[]`.
5. Read `prompts/job_search_prompt.md` and `employers/prospective_employers.md` for target-company context.

## Search Rules

- Use current web data. Job availability, links, and requirements become stale quickly.
- Search official career sites first where practical; use job boards for discovery and then verify on employer sites.
- Every recommended role needs a role link. Prefer a direct posting link. If only a search page is possible, mark `Link Status` as `Search`.
- Verify the final apply destination before labeling a role `Direct` or recommending it. Public detail pages can remain live after the ATS/apply flow closes.
- For Workday apply links, check the page source for `postingAvailable: true`; if it is `false`, mark the lead stale even if the employer detail page still renders.
- For embedded job widgets (e.g. Workable), verify the current widget feed or direct job page, not only search snippets or third-party mirrors.
- Exclude roles below `searchBrief.levelFilter`, below about 70% fit, requiring a language the candidate lacks, or explicit no-sponsorship (when sponsorship is needed).
- **Current-employer roles** are in scope as standard external applications, but follow `currentEmployerExclusion` in `config/candidate.json` (do not use its internal mobility platform; do not surface the candidate's own current role/team).
- Do not infer sponsorship too strongly from silence. Use `likely`, `unclear`, or `excluded`.
- Prefer the candidate's target locations in the order given in `searchBrief.targetLocations`.

## ATS Harvest First

`tracking/ats_candidates.json` is a pre-fetched list of **live** postings pulled straight from employer ATS JSON APIs (Greenhouse/Lever/Ashby/SmartRecruiters/Workday) plus Google Careers by `dashboard/scripts/fetch_ats.mjs`. It is multi-employer — every employer in `dashboard/scripts/ats_sources.json` is harvested each run. These APIs are **not bot-blocked** the way rendered career pages are (`WebFetch` regularly gets HTTP 403 on Google/Lever/Ashby/SmartRecruiters/Workday pages, which is the main reason past runs "found nothing"). Always start discovery here:

1. If it is missing or `meta.fetchedAt` is older than today, run `node dashboard/scripts/fetch_ats.mjs` to refresh it (the dashboard pipeline does this automatically as step 0).
2. Curate the candidates: apply the rubric below, dedupe against `roles[]`, log the genuine fits.
3. When you find a real role on a page that 403s, **add the employer's ATS slug to `dashboard/scripts/ats_sources.json` and re-run the harvester** rather than abandoning the role.

## Two-Tier Logging — do not discard a real find over a verification gap

The bar to **log** a candidate (`status NEW`) is lower than the bar to **recommend** it:

- A genuine fit whose apply page is bot-blocked/unfetchable is still logged as `NEW` with `linkStatus UNVERIFIED` and a `statusNote` explaining the gap. Surfacing an unverified real fit beats showing the family nothing.
- Only roles whose direct employer/ATS page was actually confirmed live get `linkStatus VERIFIED`/`DIRECT`.
- Reserve **OMIT** for genuine non-fits, not for verification gaps.

## Re-verification Is a Rotating Slice — not all roles every run

Do **not** re-verify every active role on every run; that crowds out discovery. Each run, re-verify the roles that are (a) stalest (`lastUpdate` > 7 days) or (b) carry a family comment. Roles verified in the last few days can be trusted; spend the saved budget finding new leads.

## Sources (priority order)

0. **ATS harvest** (`tracking/ats_candidates.json`) — start here; see above.
1. **Employer career sites** — always preferred; verify the apply flow.
2. **High-signal aggregators** relevant to the candidate's domain and region (e.g. sector-specific boards, curated local dev-job boards with a visa-sponsorship filter, specialist recruiter boards).
3. **Discovery only** (always trace back to the employer-site posting): general boards, LinkedIn, Indeed, Glassdoor.

## Two-Step Aggregator Verification

Anything found on an aggregator is a **candidate, not a confirmed lead**. Step 2 is to verify directly **before** recommending the candidate apply:
- Recruiter-posted role → confirm **with the recruiter**: real role, end employer, exact location, seniority, sponsorship, still open.
- Other aggregator role → confirm on the **employer career site / ATS apply flow**.
- Mark aggregator-only finds `Unverified` until step 2 is complete; never label them `Direct`.

## Dedup Before Logging (mandatory)

Cross-check every candidate against the existing `roles[]` (match on company + role + internalId):
- **Skip** roles the candidate already applied to (displayed status `APPLIED`) — support those instead of duplicating.
- **Deprioritize** employers that recently **rejected** the candidate (roles at `REJECTED`) unless the new role is a clearly different team.
- Never re-add a role already present in `roles[]`; update the existing row instead.

## Match Rubric (must pass ALL — never pad to hit a count)

- **Level:** at or above `searchBrief.levelFilter`. Exclude graduate, intern, junior.
- **Role type:** the categories in `searchBrief.targetRoles` (typically production/platform/distributed-systems engineering, OR **applied** LLM/agentic/GenAI *product or platform* engineering). Exclude AI research / model pre-/post-training, CV/speech/biology modeling, and mobile/consumer-frontend-only roles unless they are in `targetRoles`.
- **Developer-first evidence:** for HIGH priority, the role must be primarily hands-on software engineering in production systems. Architect, EM, customer-solutions, sales engineering, implementation, TPM, or guild/standards roles are MEDIUM at best unless the candidate explicitly asks for that track.
- **Not DevOps/infra/MLOps:** the test is whether the **primary day-to-day deliverable** is **building software** vs **operating/maintaining** infrastructure. EXCLUDE roles whose main work is production Kubernetes ops, Terraform/Ansible IaC, observability/on-call, or running LLM inference stacks (vLLM/Triton/KServe/Ray Serve). A role that happens to *deploy* on K8s is fine; a role whose *output* IS the cluster/platform is not.
- **Language/stack fit:** the candidate's core languages are in `searchBrief.strongLanguages`. EXCLUDE or downgrade roles where a `searchBrief.weakLanguages` language is the **primary** language or demands hard senior depth with no ramp-up. A single mention alongside a strong language does **not** trigger exclusion — only roles where a weak language is the core engineering language do.
- **Evidence threshold:** quote or paraphrase the posting's actual responsibilities and requirements. Do not infer fit from title, company, or keywords alone.
- **Location:** verify the posting's actual city — a title containing APAC / EMEA / a city / "remote-US" overrides any assumption. Follow `searchBrief.targetLocations`.
- **Sponsorship:** likely / unclear / excluded (see `searchBrief.sponsorship`). Large multinationals & banks → likely; startups → confirm first.
- **Not** already applied/rejected. Current-employer roles are allowed per `currentEmployerExclusion`.

## Critical Suitability Gate

Before logging or promoting a lead, write a short negative-fit check:

- Does this role under-level the candidate despite a senior-sounding title?
- Is it mainly customer implementation, generic frontend/full-stack, pure research, or management-only work?
- Is it an architect role rather than developer-first delivery? If yes, downgrade unless the candidate explicitly wants architecture ownership.
- Is it really a DevOps/SRE/infra/MLOps/model-serving role dressed up as engineering? If yes, exclude or LOW.
- Does the core stack demand a `searchBrief.weakLanguages` language at senior depth with no ramp-up room? If yes, exclude or downgrade.
- Is sponsorship weak because the employer is a startup, contract recruiter, or asks for an existing local work permit?
- Is compensation likely materially below the candidate's current-level alternatives?
- Has the candidate recently been rejected by this employer, or is there an active application already in the pipeline?

If any answer is yes, either exclude it or downgrade it with the reason. A keyword match is not enough.

## Evaluation Fields

Capture these for each qualified role: Company, exact Role Title, Internal Position ID (`not exposed` only after checking), Location, Job Link, Link Status, Language Req, Visa Status (likely/unclear/excluded), Skill Match %, Key Match Points, Key Gaps, Salary Range (mark **(stated)** if from the posting, **(est.)** if inferred), Critical Fit Verdict, and Priority (HIGH/MEDIUM/LOW).

## Updating Files

- Add qualified roles to `roles[]` in `tracking/search_results.json`. Allocate the id from `meta.nextId` (`R-####`) and increment `meta.nextId`. Do not recreate the old `results[]`/`applications[]` split.
- Set the base `status` (`NEW`/`OPEN`/`APPLIED`/`DECLINED`/`ARCHIVED`) and put reasons/caveats in `statusNote`. New finds = `NEW`; demote prior `NEW` to `OPEN` only if their `createdDate` is more than 7 days ago. Set base `DECLINED` only for employer rejections, base `APPLIED` only on recruiter evidence — the family's `userApplied`/`userRejected` ticks handle their own actions. Never set `userApplied`, `userRejected`, or `comments`.
- Store the internal position ID in `internalId` whenever exposed (Workday req IDs, Greenhouse/Lever/Ashby IDs, SuccessFactors req IDs, `gh_jid`, numeric IDs in employer URLs); else `not exposed`.
- Set `salaryRange` (ALWAYS — estimate with ` (est.)` if unstated), `pros` (array), `cons` (array), `fitRiskSummary`, `nextAction`, `priority`, and `linkStatus` (`VERIFIED`/`DIRECT`/`SEARCH`/`UNVERIFIED`/`STALE`). Set `peerReviewed` only when the OTHER model reviewed it.
- `reports/search_results.md` is GENERATED from the JSON — never hand-edit it (the dashboard regenerates it on save).
- ONLY the final step of a full pipeline run pushes ONE run summary to the **END** of `runSummaries[]` — use `.push()` or `[...existing, newEntry]`, never prepend (intermediate steps must not write summaries — duplicates break the dashboard): `{date, agent, requestId, newRoles, archived, removed, emails:{applications,replies,rejections,interviews}, highlights, marketNotes}` (real counts; 0 when N/A). Powers the dashboard "Latest run" tab.
- Check `tracking/dashboard_requests.json` for user-created action requests and update/close requests you handle.
- Update `memory/search_history.md` (the search report, scope, key outcome), `memory/agent_memory.md` (durable lessons only), and `memory/improvements.md` (process problems / ideas).

## Consolidated Search Results Format

The single source is `tracking/search_results.json` (`roles[]`); `reports/search_results.md` is generated from it (sections: Best Jobs ranked, Applications, All Roles, Latest Gmail Status Updates). Each role must include: `id` (permanent `R-####`), `createdDate`/`lastUpdate`, `company`, `role`, `internalId`, `location`, `link`, `status` (+ `statusNote`), family-owned `userApplied`/`userRejected`/`comments` (never set by agents), `peerReviewed`, `priority`, `linkStatus`, `salaryRange` (always), `pros` (array, green list), `cons` (array, amber list), `fitRiskSummary`, and `nextAction`.

## Application Tips (consider when recommending a role)

### Before applying
- Check the candidate's network for a connection at the company — a referral dramatically increases response rates. If there is a clear connection, flag it in `nextAction` ("seek referral via [Name]") and recommend pursuing it before cold-applying.
- Confirm the company sponsors when the candidate needs sponsorship. Large multinationals = likely; scaleups/startups = check the posting or HR; no sponsorship = exclude.
- If a role requires a language the candidate lacks, skip unless the posting says the candidate's language is accepted.

### Cover letter — what to lead with
- Tailor the opening to the role type and the candidate's strongest relevant experience (from `config/candidate.json` `profile`), matched to the job description.
- Add 1–2 company-specific facts (engineering blog post, open-source contribution, recent launch).
- State relocation/availability accurately (from the candidate's situation), and never overstate work authorization.
- Use the dashboard cover-letter generator (`/api/cover-letter`), which reads the harvested JD + the candidate's profile. Save output to `cover_letters/<company>_<role>.md`.

### After applying
- If no acknowledgement within 5 business days, one brief follow-up is appropriate. Note it in the role's `comments` field.
- Log any interview invitation immediately in `statusNote`; do not change base `status` (family owns `userApplied`).
- After each interview, note format, key questions, and outcome in `comments`. Store per-company prep in `cover_letters/<company>_interview_prep.md`.

## End-of-Session Checklist

- `tracking/search_results.json` (`roles[]`) updated or explicitly left unchanged; `meta.nextId` incremented for any new roles.
- `reports/search_results.md` regenerated from the JSON (not hand-edited).
- `tracking/dashboard_requests.json` checked and any handled request closed or annotated.
- `memory/search_history.md` updated; durable lessons in `memory/agent_memory.md`; improvements in `memory/improvements.md`.
- **Coordination Board updated:** release your number block, clear "in progress" claims, leave any `@peer` handoffs.
