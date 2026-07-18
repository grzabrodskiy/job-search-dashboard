# Job Search Dashboard

A local, agent-driven job-search cockpit. It harvests live postings from employer ATS APIs, curates
them against one candidate's brief, tracks applications, generates tailored cover letters, and runs
Claude/Codex search sessions — all backed by a single JSON source of truth and a small web dashboard.

The app is **candidate-agnostic**: every personal detail lives in one gitignored file
(`config/candidate.json`). Point it at any candidate and the whole app retargets.

## Quick start

```bash
npm install
npm run setup       # seeds config/candidate.json + tracking data from the *.example files
npm run dashboard   # → http://127.0.0.1:3000
```

Then edit **`config/candidate.json`** with the real candidate's details (name, contact, CV path,
current employer, and a `searchBrief` of target roles/locations/languages/sponsorship). See
`config/candidate.example.json` for the schema. Fresh clones run out of the box with a fake sample
candidate ("Amber Russian Gold") and a few sample roles.

Optional: `npm run harvest` refreshes the ATS candidate pool (`tracking/ats_candidates.json`) from the
sources in `dashboard/scripts/ats_sources.json`.

## Architecture

- **`config/candidate.json`** — the single source of candidate facts (gitignored). Loaded by the
  server and injected into every prompt, cover letter, and the dashboard header.
- **`tracking/search_results.json`** — the single source of truth for roles: one `roles[]` array with
  status, priority, links, pros/cons, and `runSummaries[]`. The dashboard reads/writes it; the
  Markdown report is regenerated from it (never hand-edited).
- **`dashboard/`** — a dependency-light Node HTTP server (`server.mjs`) + a vanilla-JS front end
  (`public/`). It serves the tracker, runs the ATS harvest, spawns Claude/Codex runs, and generates
  cover letters. Run model/thinking-effort and search scope are chosen in the "Run" popup.
- **`dashboard/scripts/`** — the ATS harvesters (`fetch_ats.mjs`, `fetch_browser.mjs`) and their
  source config.
- **`workflows/`, `prompts/`, `.claude/`, `.codex/`** — the shared agent playbooks, the reusable
  search prompt, and thin Claude/Codex wrappers. All read the candidate from `config/candidate.json`.
- **`memory/`** — durable agent memory (data files are gitignored; the README + protocols are not).

## Privacy

All personal data and identity are gitignored and never committed:

- `config/candidate.json` — the candidate's profile and PII
- `tracking/*.json` — real trackers, applications, and harvested postings (only `*.example.json` is committed)
- `reports/` — generated run reports and agent logs
- `cover_letters/` — generated letters
- personal `memory/*.md` data files
- `.claude/settings.local.json`

See `.gitignore` for the full list. The committed tree contains only the reusable application and
anonymized sample data.

## License

MIT
