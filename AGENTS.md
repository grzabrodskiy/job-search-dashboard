# Codex Instructions: Job Search Dashboard

This workspace is shared between Claude and Codex. `CLAUDE.md` is the shared project brief and
`config/candidate.json` is the source of truth for candidate facts. Do not rename, rewrite, or split
them just for Codex. Use this file as the Codex wrapper.

## Startup Checklist

- Read `CLAUDE.md` before substantive work.
- Read `memory/README.md`, `memory/agent_memory.md`, and `workflows/memory_protocol.md` before substantive job-search work.
- Read `workflows/collaboration_protocol.md` and `memory/coordination_board.md` before tracker edits or searches; reserve IDs and post in-progress claims when adding rows.
- Review the peer's unreviewed leads before hunting new ones, and mark each review as ENDORSED, DOWNGRADE, REJECT, REWORK, or CONFLICT.
- Read `tracking/search_results.json` (the single source of truth: one `roles[]` array) and `tracking/dashboard_requests.json` before search/status work; the dashboard may contain user comments, status changes, and action requests. `tracking/leads.md` and `tracking/applications.md` are retired — do not recreate them.
- For new searches, read `workflows/search_session.md` and `prompts/job_search_prompt.md`; use `employers/prospective_employers.md` for target employer context.
- Read `config/candidate.json` for candidate facts; for cover letters or detailed fit analysis, also read the CV at the `cvPath` given there if available.

## Working Rules

- Job postings are time-sensitive. Use current web data for searches and role verification.
- Prefer direct employer career-site links. Job-board links are acceptable for discovery, but verify against the employer site where possible.
- Include a direct role link in every recommendation; if only a search page is available, mark it as `Search` and note the verification gap.
- Store and display the internal position ID whenever available. Use the employer/ATS req ID, Workday ID, Greenhouse/Lever/Ashby ID, SmartRecruiters ID, `gh_jid`, or numeric ID embedded in the role URL; write `not exposed` if none is visible.
- Exclude roles below the candidate's `searchBrief.levelFilter`, roles requiring a language the candidate lacks, and roles that explicitly cannot sponsor when sponsorship is needed.
- **Current-employer roles:** in scope as standard external applications, but follow `currentEmployerExclusion` in `config/candidate.json` — do not use the employer's internal mobility platform and do not surface the candidate's own current role/team.
- Treat sponsorship as `likely`, `unclear`, or `excluded`; do not overstate it when the job ad is silent.
- Keep facts about the candidate truthful and grounded in `config/candidate.json`, the CV, and existing tracking files.
- Use exact dates in reports and status updates.

## File Editing Rules

- `tracking/search_results.json` is the SINGLE source of truth. One `roles[]` array; each role has a permanent `id` (`R-####`, from `meta.nextId` — increment it when adding a role). The agent sets the base `status`: `NEW` (added by this search), `OPEN` (active candidate), `APPLIED`, `DECLINED`, `ARCHIVED`. Put reasons/details in `statusNote`. `linkStatus` ∈ {`VERIFIED`, `DIRECT`, `SEARCH`, `UNVERIFIED`, `STALE`}.
- **Re-verify ALL open roles every run (no exceptions):** every active (NEW/OPEN) role is re-checked, whether or not it has a comment. For each: open its live apply page to confirm the posting still exists, critically re-review fit/level/location/sponsorship, update linkStatus/fitRiskSummary, and set status `ARCHIVED` if the posting is gone. **Additionally**, where a role has a `comment`, address what it asks and record the answer in `statusNote`.
- **Family-owned fields you must NOT set or overwrite:** `userApplied` (candidate applied), `userRejected` (candidate declined), `comments`. The displayed status is derived: `userRejected`/base `DECLINED` → Declined; `userApplied`/base `APPLIED` → Applied; base `ARCHIVED` or 30+ idle days → Archived; else NEW/OPEN.
- **Base `APPLIED`/`DECLINED` = confirmed email evidence only**, and they LOCK the family's Applied/Reject checkbox in the dashboard. From the email scan: application seen → base `APPLIED`; employer rejection → base `DECLINED` (statusNote "rejected by employer"). Never set base `DECLINED` for a family "not interested" decision (that's their `userRejected`). Don't set these without evidence.
- **`NEW` means "added by the latest search."** At the start of each search pass, demote every existing `NEW` role to `OPEN`, then add this pass's finds as `NEW`.
- **Use `comments` to improve the search:** read them as standing family guidance, apply them this pass, and distill durable ones into `memory/improvements.md` / `memory/agent_memory.md`.
- Do NOT recreate the old `results[]`/`applications[]` split, `manual*` fields, the old multi-status funnel, or `tracking/leads.md` / `tracking/applications.md`. Applications are just roles whose displayed status is `APPLIED`.
- Edit only the JSON. `reports/search_results.md` is generated from it — never hand-edit it.
- **Run summary (final step only):** ONLY the last step of a full pipeline run appends ONE object to `runSummaries[]` in `tracking/search_results.json` — intermediate steps must NOT write one (duplicate same-date entries break the dashboard). Schema: `{date, agent, requestId, newRoles, archived, removed, emails:{applications,replies,rejections,interviews}, highlights, marketNotes}`. Use real counts (0 when nothing applies). The dashboard "Latest run" tab and the generated report read this.
- Treat `tracking/dashboard_requests.json` as the queue of user-created action requests from dashboard buttons. Close or comment on requests there when acted on.
- Keep old dated reports under `reports/search_YYYY-MM-DD_topic.<agent>.md` as archival notes only; create new dated reports only for unusually large audits or when the user explicitly asks.
- Update `memory/search_history.md` after material search/status updates.
- Add durable lessons to `memory/agent_memory.md`; add proposed prompt/instruction improvements to `memory/improvements.md`.
- Keep cover letters in `cover_letters/` with descriptive lowercase filenames.
- Do not delete historical leads, applications, or reports unless explicitly asked.

## Gmail

- Use Gmail tools only when the user asks to monitor or act on email.
- Search the configured `monitoredInbox` (see `config/candidate.json`) for forwarded job replies related to roles with displayed status `APPLIED`.
- Do not send, reply, forward, archive, or delete email without explicit user instruction.

## Codex Skill

- The project-local Codex skill lives at `.codex/skills/job-search/SKILL.md`.
- When a task is specifically about searching roles, updating trackers, monitoring replies, or writing cover letters, follow that skill's workflow as the detailed playbook.
- Keep shared process instructions in `workflows/`; update this file only for Codex-specific behavior.
