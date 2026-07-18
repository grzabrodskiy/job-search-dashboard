# Shared Agent Memory

This directory is the shared memory layer for Claude and Codex.

Read these files at the start of any substantive job-search task:

- `memory/coordination_board.md` — **live co-recruiter board** (number reservations, in-progress claims, handoffs). Read first, update as you go.
- `memory/agent_memory.md` — durable facts and lessons for future searches.
- `memory/search_history.md` — compact index of search sessions and reports.
- `memory/improvements.md` — open improvements to instructions, skills, prompts, and trackers.

Operating agreement for the two agents: `workflows/collaboration_protocol.md`.

Follow `workflows/memory_protocol.md` when adding or changing memory.

## Ownership

- Candidate profile and core facts live in `CLAUDE.md`.
- Agent operating rules live in `workflows/`.
- Model-specific wrappers should stay thin and point to shared files.
- Trackers remain the source of truth for leads and applications.
