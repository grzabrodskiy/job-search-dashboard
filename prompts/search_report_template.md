# Role Field Reference (salary + data model)

`reports/search_results.md` is GENERATED from `tracking/search_results.json` — do not hand-write it. Update the JSON `roles[]` instead; the dashboard regenerates the markdown on save (sections: Best Jobs, Applications, All Roles, Gmail Updates). Old dated reports in `reports/search_YYYY-MM-DD_topic.<agent>.md` are archival only.

Each role in `roles[]` has these fields:

- `id` — permanent `R-####` (from `meta.nextId`, never reused)
- `createdDate`, `lastUpdate`
- `company`, `role`, `internalId` (`not exposed` only after checking), `location`, `link`
- `status` — agent base status: `NEW` (added this search), `OPEN` (active), `APPLIED`, `DECLINED`, `ARCHIVED`. (Displayed status is derived from this + family checkboxes + 30-day age.)
- `statusNote` — reason/detail for the status (rejection reason, blocker, verification gap)
- `userApplied` / `userRejected` — family-owned booleans; never set by agents
- `peerReviewed` — `true` only when the OTHER model reviewed it
- `priority` — `HIGH` / `MEDIUM` / `LOW`
- `linkStatus` — `VERIFIED` / `DIRECT` / `SEARCH` / `UNVERIFIED` / `STALE`
- `salaryRange`, `fitRiskSummary`, `nextAction`
- `comments` — family guidance; never overwrite; read it to improve the search

Every qualified role must include an approximate salary range and the internal position ID when available.

---

## Salary Range Rules

1. Prefer the posting. If the ad states a range, quote it and mark `(stated)`.
2. Otherwise estimate from market data for role + location + seniority and mark `(est.)`.
3. Always use a range in local currency: CHF for Switzerland, EUR for Munich/Paris/Amsterdam.
4. Quote total comp where possible; note if base-only.
5. If no credible estimate exists, write `unknown - confirm with recruiter`.

### Rough Senior-Engineer Reference Bands

- Zurich senior/lead SWE: CHF 150K-230K; staff/principal and quant dev at banks/hedge funds: CHF 200K-350K+.
- Geneva senior/lead SWE: CHF 140K-220K.
- Munich senior/lead SWE: EUR 90K-150K; US big tech/trading offices higher.
- Paris senior/lead SWE: EUR 80K-140K; Datadog/quant funds higher, EUR 120K-230K+.
- Amsterdam prop trading experienced: EUR 180K-300K+ total comp.
