# Job Search Prompt

Use this prompt when running job searches. Before using it, read `workflows/search_session.md` (match rubric, application tips, output format, end-of-session checklist), `memory/agent_memory.md`, `tracking/search_results.json` (single source of truth), and `tracking/dashboard_requests.json`.

**Start discovery from `tracking/ats_candidates.json`** — a pre-fetched list of live postings from employer ATS JSON APIs (not bot-blocked). Refresh with `node dashboard/scripts/fetch_ats.mjs` if stale. Log genuine fits even if their apply page is 403-blocked (mark `linkStatus UNVERIFIED`).

---

## Candidate

Read `config/candidate.json` for the full profile, core languages, stack, domain, citizenship/
sponsorship, target locations, and CV path. Everything below derives from its `searchBrief` —
do not hard-code candidate details here.

## Search Goal

Roles at or above `searchBrief.levelFilter` in the candidate's `searchBrief.targetLocations`, in the
role types listed in `searchBrief.targetRoles` (priority order). Exclude: below-level/graduate,
roles whose primary language is one of `searchBrief.weakLanguages`, DevOps/SRE/infra/MLOps ops,
research-scientist, mobile-only, and roles requiring a language the candidate lacks. Current-employer
roles are in scope as standard external applications, but follow `currentEmployerExclusion`.

## Target Employers

Example large employers that typically sponsor non-EU workers (tailor this list to the candidate's
`searchBrief.targetLocations`; see `employers/prospective_employers.md` for the full list):

- **Swiss-HQ firms:** UBS, SIX Group, Vontobel, Avaloq, Swissquote, Sygnum, Julius Baer
- **International banks with Swiss offices:** JPMorgan, Deutsche Bank, Morgan Stanley, Citi
- **Asset managers / hedge funds:** Citadel, Millennium, Winton, Man Group, Pictet, Partners Group
- **Commodity trading / prop trading:** Vitol, Glencore, Trafigura, QRT, CFM, Optiver, DRW
- **Big tech (Zurich offices):** Google, Meta, Microsoft, Amazon
- **AI companies:** OpenAI, Anthropic, Mistral AI, Cohere, Helsing, Databricks, Datadog
- **Insurers:** Swiss Re, Zurich Insurance
- **Other Swiss tech:** On (ONON), Proton, Scandit, SonarSource, Frontify, DeepJudge, 21Shares

See `employers/prospective_employers.md` for the full list. Always search beyond it.

## Quick Search Queries

For web searches, combine:

**Titles:** "Lead Software Engineer" OR "Senior Software Engineer" OR "Staff Software Engineer" OR "Principal Engineer" OR "Applied AI Engineer" OR "Forward Deployed Engineer" OR "Platform Engineer" OR "Quant Developer" OR "VP Engineering"

**Locations:** Zurich OR Zürich OR Zug OR Geneva OR Basel OR Switzerland OR Munich OR München OR Paris

**Domains:** trading systems OR fintech OR distributed systems OR low-latency OR capital markets OR agentic AI OR LLM

**Job boards:** site:swissdevjobs.ch (use visa-sponsorship filter) · efinancialcareers.com · jobs.ch · linkedin.com/jobs
