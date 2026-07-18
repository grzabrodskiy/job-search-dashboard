---
name: job-search
description: Use when working in the JobSearch workspace on the candidate's job search — finding and evaluating roles in the candidate's target locations, updating leads and applications, checking job-related email, writing search reports, and drafting cover letters. The candidate's profile and search brief live in config/candidate.json.
---

# Job Search

## Start Here

1. Read `config/candidate.json` (the candidate profile + `searchBrief`), then root `AGENTS.md` and `CLAUDE.md`.
2. Read `memory/README.md`, `memory/agent_memory.md`, and `workflows/memory_protocol.md`.
3. For status, search, or application-tracking work, read `tracking/search_results.json` (the single source of truth — one `roles[]` array) and `tracking/dashboard_requests.json`.
4. For new searches, read `workflows/search_session.md` and `prompts/job_search_prompt.md`.
5. For target-company context, read `employers/prospective_employers.md`.
6. For cover letters or deep role-fit analysis, read the CV at the `cvPath` in `config/candidate.json` if available.

## Search Workflow

- Use current web data; job postings and application links go stale quickly.
- Prefer official employer career pages over job boards. Use job boards only for discovery when needed.
- Verify specific role links where possible. If a posting cannot be linked directly, use the employer search page and mark link status as `Search`.
- Prioritize the candidate's target locations in the order given in `searchBrief.targetLocations`.
- Focus on the role types in `searchBrief.targetRoles` (typically senior backend, platform, distributed systems, applied AI/LLM, quant developer, tech lead).
- Exclude roles below `searchBrief.levelFilter`, roles below about 70% fit, roles requiring a language the candidate lacks, and roles that explicitly cannot sponsor when sponsorship is needed.
- **Current-employer roles:** in scope as standard external applications, but follow `currentEmployerExclusion` in `config/candidate.json` — do not use the employer's internal mobility platform and do not surface the candidate's own current role/team.
- Exclude (or LOW only) DevOps/SRE/infra/MLOps/model-serving roles (production K8s ops, Terraform/Ansible IaC, observability/on-call, vLLM/Triton/KServe inference-stack operations). This candidate builds software/products/agents, not platform operations.
- Exclude or downgrade roles requiring one of the candidate's `searchBrief.weakLanguages` as a hard senior requirement (e.g. "strong modern C++, 8+ yrs"). The candidate's strong languages are in `searchBrief.strongLanguages`. Keep only if the language is one of several accepted or the role allows ramp-up time.
- Treat sponsorship cautiously: mark it as likely only for known large sponsors or explicit sponsorship language; otherwise mark unclear.
- Include an approximate salary range for every qualified or audited role. Mark it stated if from the posting, otherwise estimated from market data for role/location/seniority.
- Store/display the internal position ID whenever available. Use the employer/ATS req ID, Workday ID, Greenhouse/Lever/Ashby ID, SmartRecruiters ID, `gh_jid`, or numeric ID embedded in the role URL; use `not exposed` only after checking.
- Do a negative-fit check before ranking a role highly: under-leveling, startup sponsorship risk, weak compensation, generic implementation work, prior rejection, or duplicate active application should downgrade or exclude the role.
- HIGH priority roles must be developer-first: hands-on production software engineering, platform/backend systems, or applied AI platform/tooling. Architect, manager, customer-solutions, implementation, sales engineering, TPM, guild/standards, or strategy-heavy roles are MEDIUM at best unless the candidate explicitly wants that track.
- Be thorough: verify exact title, location, final apply-page status, seniority, stack/domain fit, language, sponsorship risk, salary, and duplicate/rejection status before recommending.

## Lead Evaluation

For each qualified role, capture:

- Company, title, location, and direct link.
- Internal position ID when available.
- Developer-first vs architecture/manager/customer-solution classification.
- Language requirement.
- Sponsorship status: likely, unclear, or excluded.
- Estimated skill match percentage.
- Key match points and key gaps.
- Approximate salary range in local currency.
- Critical fit verdict: why it is worth the candidate's time and the main reason it might not be.
- Priority: HIGH, MEDIUM, or LOW.

HIGH should mean strong skill fit, seniority fit, target location or employer, and sponsorship likely. MEDIUM should mean good fit with some uncertainty. LOW should mean watchlist quality only.

## Updating Trackers

- `tracking/search_results.json` is the SINGLE source of truth: one `roles[]` array. Add a new role by allocating the next id from `meta.nextId` (`R-####`) and incrementing `meta.nextId`. Do not recreate the old `results[]`/`applications[]` split, `manual*` fields, or the old multi-status funnel.
- The agent sets the base `status`: `NEW` (added by this search), `OPEN` (active), `APPLIED`, `DECLINED`, `ARCHIVED`. The displayed status is derived from the base plus the family's `userApplied`/`userRejected` booleans plus age (30+ idle days → Archived). Put reasons/caveats in `statusNote`.
- **NEW = added by the latest search.** Start each search by demoting all existing `NEW` roles to `OPEN`, then add this pass's finds as `NEW`.
- **Re-verify ALL open roles every run (no exceptions):** every active (NEW/OPEN) role is re-checked whether or not it has a comment — confirm the posting still exists, critically re-review, update fields, ARCHIVE if gone. Additionally, where a role has a `comment`, address it and record the answer in `statusNote`.
- **Family-owned — never set or overwrite:** `userApplied`, `userRejected`, `comments`. Base `APPLIED`/`DECLINED` are CONFIRMED EMAIL EVIDENCE only (application seen / employer rejection) and they LOCK the family's Applied/Reject checkbox — set base `APPLIED` only on recruiter evidence, base `DECLINED` only for employer rejections (statusNote "rejected by employer"), and never use base `DECLINED` for a family "not interested" decision.
- **Use `comments` to improve the search:** treat them as standing guidance, apply them, and distill durable ones into `memory/improvements.md` / `memory/agent_memory.md`.
- `linkStatus` ∈ {`VERIFIED`, `DIRECT`, `SEARCH`, `UNVERIFIED`, `STALE`}. `peerReviewed` is `true` only when the OTHER model checked the row.
- Keep historical roles; mark dead/filled ones `ARCHIVED` rather than deleting them.

## Consolidated Search Results

ONLY the final step of a full pipeline run appends ONE run summary to `runSummaries[]` in `tracking/search_results.json` (intermediate steps must not — duplicate entries break the dashboard): `{date, agent, requestId, newRoles, archived, removed, emails:{applications,replies,rejections,interviews}, highlights, marketNotes}` (real counts; 0 when N/A) — it powers the dashboard "Latest run" tab.

`reports/search_results.md` is GENERATED from `tracking/search_results.json` — never hand-edit it. After a search run or Gmail status pass, update the JSON only; the dashboard regenerates the markdown on save (sections: Best Jobs ranked, Applications, All Roles, Gmail Updates). For each role keep: company, role, internalId, location, link, status (+ statusNote), priority, linkStatus, salaryRange, fitRiskSummary, nextAction, peerReviewed. Append Gmail status changes to `gmailUpdates`.

Dated reports under `reports/search_YYYY-MM-DD_topic.<agent>.md` are archival only. Create one only for large audits or when the user explicitly asks.

Then update `memory/search_history.md`. Add only durable lessons to `memory/agent_memory.md` and process ideas to `memory/improvements.md`.

## Gmail Monitoring

- Use Gmail only when the user asks to check replies or manage email.
- Search the configured `monitoredInbox` (see `config/candidate.json`) for forwarded replies related to roles with displayed status `APPLIED` in `tracking/search_results.json`.
- Do not send, reply, forward, archive, label, or delete email without explicit instruction.

## Cover Letters

- Keep letters truthful and grounded in `config/candidate.json` (the `profile`), the CV, and the job posting.
- Emphasize the candidate's strongest, most relevant experience for the specific role (match the job description).
- Address sponsorship carefully; do not imply the candidate already has work authorization they do not have.
- Save generated letters in `cover_letters/` with descriptive lowercase filenames.
