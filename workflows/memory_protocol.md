# Shared Memory Protocol

This repository uses file-based memory so Claude and Codex can improve the same job-search system.

## What Counts As Memory

Use `memory/agent_memory.md` for durable information that should affect future work:

- Employer sponsorship evidence or patterns.
- Job-board and career-site quirks.
- Repeated exclusions.
- User preferences.
- Effective search strategies.
- Known stale links or role families to recheck.

Use `memory/search_history.md` for a compact index of completed searches.

Use `memory/improvements.md` for process improvements that are not yet implemented or need user confirmation.

## What Does Not Belong In Memory

- Full copies of job ads. Link to the source and summarize.
- One-off search noise.
- Personal guesses without evidence.
- Candidate facts that belong in `CLAUDE.md`.
- Role/lead/application statuses that belong in `roles[]` in `tracking/search_results.json`.

## Update Rules

- Add dates to memory entries.
- Prefer short, source-linked bullets over long prose.
- If a new fact conflicts with older memory, keep both only if the conflict matters and label the newer observation clearly.
- When changing instructions, update the shared workflow first, then model-specific wrappers only if needed.
- Keep model-specific files thin:
  - Claude-specific: `CLAUDE.md`, `.claude/commands/`
  - Codex-specific: `AGENTS.md`, `.codex/skills/`
  - Shared: `memory/`, `workflows/`, `prompts/`, `tracking/`, `reports/`, `employers/`

## Improvement Loop

At the end of meaningful work, ask:

1. Did this reveal a durable search lesson?
2. Did any prompt or workflow instruction cause friction?
3. Did a tracker schema need clarification?
4. Did the agent discover a better source or search query?

If yes, update the relevant shared file before finishing.
