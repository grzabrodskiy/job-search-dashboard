# Co-Recruiter Collaboration Protocol (Claude + Codex)

Claude and Codex work as **two colleague recruiters** on the same desk for one candidate (see `config/candidate.json`).
Goal: complementary coverage, no collisions, no duplicated effort, one consistent shortlist.
This file is shared. Both agents read it at the start of any job-search work (see `workflows/search_session.md` step 0).

## 1. Mindset
- We are teammates, not duplicates. Assume the other recruiter is competent and may have touched the files since you last looked. **Re-read the trackers and the Coordination Board before acting.**
- Prefer to *extend and correct* each other's work over redoing it. If you disagree with a peer entry, **annotate and propose** — do not silently overwrite or delete it.
- The client values precision over volume. A short verified shortlist beats a long unverified one.

## 1a. Active teamwork (not just collision-avoidance) — REQUIRED
The two agents must actively help each other, not merely stay out of each other's way. Every session:

1. **Pick up the peer's unfinished work first.** Before starting anything new, scan the Coordination Board "In progress" + "Handoffs", any `@you` tags, and trackers for items the peer left open — `needs check`, `Unverified`, `confirm liveness`, `find direct link`, `Search` status, "to be confirmed". Advance those before opening fresh threads.
2. **Verify the peer's work.** Spot-check recently added/changed peer entries (location, level, apply-flow status, sponsorship, salary, dedup). If a peer lead is solid, mark it ✅ verified-by-<agent> in Notes. If it's wrong/stale, annotate (don't delete) and flag on the board. Both of us have made errors the human caught — peer review is the safety net.
3. **Complement, don't duplicate.** Add what the peer's entry is missing (salary, position ID, recruiter contact, cover-letter, a verified direct link) rather than re-finding the same role. Build the entry up together.
4. **Leave clear breadcrumbs.** When you stop mid-task, record exactly what's done and what's left on the board with an `@peer` tag so the other can continue seamlessly.
5. **Close the loop.** When you complete a peer's handoff, note it resolved on the board so work isn't repeated.

## 1b. Operating model — Propose then Peer-Review (family decision 2026-05-31)
This is the core of how we work. **Both agents independently hunt for the best roles; then each critically reviews the other's suggestions before anything is recommended to the family.** Independent review is what has caught every bad lead so far — we make it mandatory and mutual.

**Lifecycle of a lead:**
1. **Propose** — Either agent logs a candidate role in `roles[]` in `tracking/search_results.json` with all required fields (location verified, level, developer-first check, sponsorship, salary, dedup, link/apply-flow status) and a `Found-by: <agent>` tag in `statusNote`. New, unreviewed roles start at base `status` = `NEW` and `peerReviewed` = false (not yet recommendable).
2. **Peer review (required)** — The *other* agent critically reviews it against the Critical Suitability Gate in `search_session.md`. The reviewer must reach one of:
   - **✅ ENDORSED by <agent>** — independently verified (re-checked location/level/apply-flow/sponsorship/salary/dedup). Only ENDORSED leads may be presented to the family as "recommended" or set HIGH.
   - **▼ DOWNGRADE / REWORK** — note what's wrong or missing and the corrected verdict (annotate, don't overwrite the peer's row).
   - **✗ REJECT** — with the disqualifying reason (e.g. wrong location, under-level, already applied, stale apply flow).
3. **Disagreement** — if proposer and reviewer can't reconcile, mark the row `CONFLICT`, keep both views, and escalate to the family in the next reply.

**Rules of the review:**
- A lead is **not** "recommended" until a *different* agent than the finder has ENDORSED it. Self-endorsement doesn't count.
- Review is **critical by default** — actively try to disqualify the role (wrong city, under-leveled, customer-solution/architect not dev-first, weak sponsorship, below-VP comp, duplicate/rejected, dead apply flow). A keyword match is never enough.
- Reviewer **adds value**, not just a verdict: fill gaps (salary, position ID, recruiter contact, verified direct link).
- Track review state in the lead's Notes: `Found-by: X | Review: PROPOSED/ENDORSED-by-Y/DOWNGRADE/REJECT/CONFLICT (date)`. Mirror open reviews on the Coordination Board so neither agent's proposals sit unreviewed.
- Each agent, at the start of a session, **clears the peer's PROPOSED queue first** (review pending proposals) before hunting for new roles.

## 2. Source of truth & ownership
- Candidate facts → `CLAUDE.md`. Operating rules → `workflows/`. `tracking/search_results.json` (one `roles[]` array) is the SINGLE live source of truth for leads and applications; `reports/search_results.md` is generated from it.
- Shared files (both edit): `memory/`, `workflows/`, `prompts/`, `tracking/`, `reports/`, `employers/`.
- Model-specific (don't cross-edit): Claude → `CLAUDE.md`, `.claude/`; Codex → `AGENTS.md`, `.codex/`.

## 3. Avoiding collisions (the #1 rule)
**IDs are now permanent `R-####` allocated from `meta.nextId` in `tracking/search_results.json`. Reserve a block so two agents don't grab the same id:**
- **Reserve a block before adding rows.** Claim a 10-id block on the Coordination Board (`memory/coordination_board.md`) — e.g. "Claude: R-0089–R-0098 (date)" — and advance `meta.nextId` past your block. Use only your reserved ids that session.
- Suggested standing split when no board entry exists yet: **Claude claims even-ending blocks, Codex odd-ending blocks.**
- **Never renumber or reuse** an id. If you spot a duplicate, leave both, note ` (dup-of R-####)` in `statusNote`, and log it on the board — don't delete the peer's row.
- One agent edits `tracking/search_results.json` at a time. If the board shows the peer is mid-edit, work elsewhere and pick it up after.

## 4. Division of labour (family decision 2026-05-31: NO fixed split; propose-then-review)
- **Both agents range freely** across all geographies, sectors, and tracks to find the best roles. There is no reserved territory.
- The split is by **lifecycle role, not territory**: whoever finds a lead *proposes* it; the *other* agent *critically reviews* it (see §1b). Every run, each agent does BOTH — produces its own list and reviews the peer's. This is a standing requirement, not optional.
- Collisions are prevented by the **Coordination Board** — post an in-progress claim and reserve a number block *before* you start. Check the board + `search_history.md` first to avoid both running the same query the same day.
- Strengths are worth leaning on opportunistically (not exclusively): Codex → ATS/apply-flow verification, Gmail status, position IDs; Claude → aggregator/recruiter discovery, salary benchmarking, cover letters. **Use the peer's strength deliberately:** hand a check you can't finish to the peer via `@peer`.

## 5. Shared standards (already in `search_session.md` — follow them)
- Match rubric (at/above searchBrief.levelFilter; target role types; correct location; sponsorship; not-already-applied; current-employer roles allowed per currentEmployerExclusion).
- Two-step aggregator rule: aggregator find → verify with recruiter/employer ATS before recommending.
- Every serious lead needs: location (city+country verified from the posting/title), link-status, sponsorship verdict, **salary range**, and a fit verdict. Never pad to a count.
- Dedup against the existing `roles[]` in `tracking/search_results.json` every time (match company + role + internalId).

## 6. Handoffs & disagreements
- Use `memory/coordination_board.md` for: number reservations, "in progress" claims, requests to the peer ("please Gmail-verify X"), and resolved/blocked items.
- Tag cross-agent requests `@codex` / `@claude`.
- If two entries conflict (e.g. different location or fit verdict for the same role), keep both, mark `CONFLICT`, and let the human decide — flag it in the next reply to the user.
- Reports stay agent-attributed: `reports/search_YYYY-MM-DD_topic.<agent>.md` (e.g. `.codex.md`). Don't overwrite the peer's report; write your own and cross-link.

## 7. End of session
- Update `search_history.md` (one row), durable lessons → `agent_memory.md`, process ideas → `improvements.md`.
- On the Coordination Board: release your number block, clear your "in progress" claims, and leave any `@peer` handoffs.
