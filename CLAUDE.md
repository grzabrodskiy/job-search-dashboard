# Job Search Dashboard - Project Brief

## Purpose
A local, agent-driven job-search dashboard. It curates job postings harvested from employer
ATS APIs, tracks applications, generates cover letters, and runs Claude/Codex search sessions —
all against a single JSON source of truth, surfaced in a small web dashboard.

The project is candidate-agnostic: **all personal details live in `config/candidate.json`**
(gitignored). Point it at any candidate and the whole app retargets.

## Candidate Profile — read this first
The candidate's name, contact info, CV path, current employer, target roles/locations, language
strengths, and sponsorship situation are **all in `config/candidate.json`** (gitignored; see
`config/candidate.example.json` for the schema). **Read `config/candidate.json` at the start of any
job-search work** — it is the single source of candidate facts. Never hard-code candidate details in
code or docs; add or change them in that file.

Key fields: `fullName`, `displayName`, `phone`, `emails[]`, `linkedin`, `cvPath`, `currentEmployer`,
`currentEmployerExclusion`, `monitoredInbox`, `profile` (narrative for cover letters), and
`searchBrief` (`targetRoles`, `targetLocations`, `levelFilter`, `strongLanguages`, `weakLanguages`,
`sponsorship`).

## Project Structure
```
JobSearch/
  config/
    candidate.json          — candidate profile + search brief (GITIGNORED; private)
    candidate.example.json  — schema + fake sample profile (committed)
  AGENTS.md                 — Codex instructions (shares this brief)
  CLAUDE.md                 — this file (project instructions)
  README.md                 — setup + architecture overview
  scripts/
    setup.mjs               — seeds gitignored working files from *.example
  .codex/skills/job-search/ — Codex project-local job-search skill
  .claude/commands/         — Claude slash commands for job-search workflows
  workflows/                — shared playbooks & protocols (search_session, memory, collaboration)
  memory/                   — durable agent memory (README committed; data files gitignored)
  tracking/
    search_results.json     — SINGLE source of truth: roles[] (leads + applications), status,
                              comments, run summaries (GITIGNORED; *.example.json committed)
    dashboard_requests.json — action requests from dashboard buttons (GITIGNORED)
    ats_candidates.json     — harvested postings, the primary discovery source (GITIGNORED)
    agent_config.json       — per-agent model + thinking-effort (GITIGNORED)
  employers/
    prospective_employers.md — categorized target-company list
  prompts/
    job_search_prompt.md    — reusable prompt for web job searches
  dashboard/                — the web dashboard (server.mjs, public/, scripts/ harvesters)
  reports/                  — generated run reports & agent logs (GITIGNORED)
  cover_letters/            — generated cover letters (GITIGNORED)
```

## Codex Setup
- Codex should read `AGENTS.md` first; it points back to this file so Claude and Codex share one brief.
- Project-local Codex skill: `.codex/skills/job-search/SKILL.md`.
- Keep the how-it-works brief here in `CLAUDE.md`; keep candidate facts in `config/candidate.json`;
  use `AGENTS.md` only for Codex-specific operating rules so the two agents do not drift.

## Shared Agent Memory
- Claude and Codex should both read `memory/README.md`, `memory/agent_memory.md`, and
  `workflows/memory_protocol.md` at the start of substantive job-search work.
- **Co-recruiter coordination:** read `workflows/collaboration_protocol.md` and
  `memory/coordination_board.md` first; reserve a number block and post an in-progress claim before
  editing trackers (Claude and Codex work the same desk).
- Use `workflows/search_session.md` as the shared search playbook.
- After every search run, update `memory/search_history.md`; add durable lessons to
  `memory/agent_memory.md`; add process ideas to `memory/improvements.md`.

## Workflow for Each Session
Follow `workflows/search_session.md` for the complete playbook. Summary:

1. **Read candidate + memory:** `config/candidate.json` (who we're searching for),
   `memory/agent_memory.md` (durable rules), `memory/coordination_board.md` (co-recruiter sync).
2. **Check dashboard inputs:** `tracking/dashboard_requests.json` (action requests),
   `tracking/search_results.json` (comments, applied/rejected flags).
3. **Curate ATS harvest:** `tracking/ats_candidates.json` is the primary discovery source — start
   here before any web search.
4. **Find new roles:** apply the match rubric in `workflows/search_session.md`; verify
   location/level/language against `config/candidate.json` before logging.
5. **Log to JSON:** add new roles to `roles[]` in `tracking/search_results.json` (`id` from
   `meta.nextId`, `status NEW`); the dashboard regenerates `reports/search_results.md` — never
   hand-edit it.
6. **Update memory:** `memory/search_history.md`, `memory/agent_memory.md`, `memory/improvements.md`.

Family actions (dashboard checkboxes): `userApplied` (candidate applied), `userRejected` (declined).
Employer rejections → agent sets base `status: DECLINED`. Roles auto-archive after 30 idle days.

## Email Monitoring
The monitored inbox and the candidate's email aliases are configured in `config/candidate.json`
(`monitoredInbox`, `emails[]`). The candidate forwards/copies job-related replies to the monitored
inbox; the agent (via its Gmail connector) searches that inbox for replies from companies of roles
with displayed status `APPLIED`, mapping each reply back to its role by permanent `R-####` id.

## Key Commands
- Search for new jobs: use the prompt in `prompts/job_search_prompt.md`.
- Check application status: read `roles[]` in `tracking/search_results.json` (displayed status).
- Add a role: append to `roles[]` (id from `meta.nextId`, base status `NEW`).
- Check email replies: search the configured `monitoredInbox` for replies from companies of
  `APPLIED` roles.

## Important Notes
- **Every lead must include a direct link to the role, preferably on the employer's own career
  site** (not Glassdoor/LinkedIn). If only a job-board link exists, note that and try to find the
  employer-site equivalent.
- **Store the internal position ID when available** (job req ID, Workday/Greenhouse/Lever/Ashby/
  SmartRecruiters ID, `gh_jid`, or numeric ID in the URL). If none is visible, write `not exposed`.
- Always check the current state of tracking files before making changes.
- Prioritize roles that mention visa sponsorship or are at large companies known to sponsor (when
  the candidate needs sponsorship — see `searchBrief.sponsorship`).
- **Current employer:** roles at the candidate's current employer (see `config/candidate.json`
  `currentEmployer`) are in scope as standard external applications, but follow
  `currentEmployerExclusion` — do not use its internal mobility platform and do not surface the
  candidate's own current role/team.
- Tailor cover letters to the role (e.g. trading systems for banks, AI/LLM for tech companies).
