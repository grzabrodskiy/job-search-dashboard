# Job Search

Run a job-search session for the candidate in `config/candidate.json`.

Before searching:

1. Read `config/candidate.json` and `CLAUDE.md`.
2. Read `memory/README.md`, `memory/agent_memory.md`, and `workflows/search_session.md`.
3. Read `tracking/search_results.json` (SINGLE source of truth — one `roles[]` array), `tracking/dashboard_requests.json`, `prompts/job_search_prompt.md`, and `employers/prospective_employers.md`. (`tracking/leads.md` and `tracking/applications.md` are retired.)

During the search:

- Use current web data.
- Prefer official employer career-site links.
- Apply the language, sponsorship, seniority, and fit filters from `searchBrief` (no DevOps/infra/MLOps). Current-employer roles are in scope as standard external applications per `currentEmployerExclusion`.
- Include approximate salary range and a critical fit verdict for every qualified role.
- Store/display the internal position ID whenever available; write `not exposed` if no req/ATS/posting ID is visible.
- Downgrade or exclude keyword matches that are under-leveled, likely unsponsored, weak on compensation, duplicate active applications, or recently rejected employers.
- HIGH priority must be developer-first. Architect, manager, customer-solution, implementation, sales engineering, TPM, guild/standards, or strategy-heavy roles are MEDIUM at best unless the candidate explicitly wants that track.
- Add qualified roles to `roles[]` in `tracking/search_results.json` (id from `meta.nextId`, single `status`, `linkStatus` from VERIFIED/DIRECT/SEARCH/UNVERIFIED/STALE, `peerReviewed` true/false). Dedupe against existing roles.
- `reports/search_results.md` is generated from the JSON on dashboard save — do not hand-edit it.
- Check `tracking/dashboard_requests.json` and close or comment on handled dashboard requests.
- Create a dated report under `reports/search_YYYY-MM-DD_topic.<agent>.md` only for large audits or when explicitly requested.

After the search:

- Update `memory/search_history.md`.
- Add durable lessons to `memory/agent_memory.md`.
- Add prompt/workflow improvement ideas to `memory/improvements.md`.
