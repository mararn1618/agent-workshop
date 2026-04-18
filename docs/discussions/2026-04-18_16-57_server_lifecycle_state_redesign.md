---
story: "Redesign agent-workshop server lifecycle, state storage, and finalize handoff to eliminate stale state, path surprises, server zombies, and fork-to-parent context loss."
created: 2026-04-18 16:57
---

# Discussion: Server Lifecycle, State Storage, and Finalize Handoff Redesign

## Intent

The current agent-workshop server has five intertwined pain points: servers linger after Claude sessions end, state files land at unpredictable `process.cwd()`-relative paths, the live-state sidecar auto-restores silently and surprises users with stale state on "fresh" starts, multiple server instances can accumulate on the same machine across harnesses/worktrees, and finalized workshop outputs never reach the parent Claude session because the skill runs in a forked context. This redesign moves session state out of project repos into a user-specific XDG location, makes the server self-manage its lifecycle with PID-file-based idempotency and post-finalize auto-shutdown, makes resume-vs-fresh decisions explicit via browser modal rather than agent flags, adds a disk-based multi-workshop overview with in-place switching, and makes the finalize→parent handoff explicit via absolute file paths returned in the fork's closing message.

## Acceptance Criteria

- [ ] Server startup is idempotent: a second `bun run server.ts` detects an already-running instance via PID file + port check and exits cleanly with a message pointing to the existing URL.
- [ ] PID file is written to `~/.local/state/agent-workshop/server.pid` on startup, contains `{pid, port, startedAt}`, is validated (PID alive + port reachable) on next start, and cleaned up on normal shutdown.
- [ ] Live state files are written to `~/.local/state/agent-workshop/live/` (respecting `$XDG_STATE_HOME` when set), never inside any project repository.
- [ ] Live state filenames follow the pattern `YYYY-MM-DD_HH-MM_<slug>_<id>.live.yaml`, where timestamp and slug are inherited from the source YAML and `<id>` is the workshop ID for collision safety.
- [ ] Source YAML files from `/workshop-prepare` follow `YYYY-MM-DD_HH-MM_<slug>.workshop.yaml` (includes time, not just date as today) and are written to `<project-root>/docs/workshops/`.
- [ ] Project root is resolved via `git rev-parse --show-toplevel` with `$PWD` as fallback when not inside a git repo. No more `process.cwd()`-relative writes.
- [ ] Finalize writes new files alongside the source, never overwriting it: `YYYY-MM-DD_HH-MM_<slug>.finalized.workshop.yaml` and `YYYY-MM-DD_HH-MM_<slug>.summary.md`. Timestamp and slug are inherited from the source file so that source and finalized artifacts sit adjacent alphabetically.
- [ ] On `POST /api/workshop/load`, when a live sidecar exists for the requested workshop but the server holds no matching in-memory state (i.e. fresh process), the browser shows a new modal asking "Resume previous state or start fresh?" — the agent does not decide this. The existing pending-load modal (different workshop already loaded) continues to function; the two modals may compose if both conditions apply.
- [ ] `GET /api/workshops` returns an array of known live-state sessions on disk `[{id, slug, timestamp, lastModified, livePath, sourcePath?}, ...]`. Implementation scans the state directory and parses minimal metadata from each file.
- [ ] Browser UI surfaces the workshop overview (exact UI placement — sidebar entry, dropdown, or modal on empty state — is a planning decision) and supports switching to a different workshop by clicking an entry, which calls the existing `/api/workshop/load` endpoint with that workshop's source path.
- [ ] After a successful finalize, the server enters a 30-second grace period during which: `POST /api/workshop/load` returns HTTP 503 with `{error: "shutting-down"}`; an SSE `shutting-down` event is broadcast to connected browsers with remaining-seconds countdown; then `process.exit(0)` runs.
- [ ] The live sidecar is deleted during finalize (current behavior, must be preserved).
- [ ] The `/workshop-start` skill's closing message (at fork exit) contains absolute paths to both the finalized YAML and the summary markdown, plus an explicit instruction to the parent session to `Read` the summary before continuing any downstream work. Example shape: `Workshop finalized. Summary (LLM-optimized, no diagrams): <abs path>. Full state: <abs path>. Read the summary now before proceeding with follow-up work.`
- [ ] Both skills remain `context: fork`. The handoff mechanism is the final-message-with-paths pattern, not removing fork.
- [ ] State directory (`~/.local/state/agent-workshop/` and subdirectories `live/`) is auto-created on first server start if missing.

## Key Decisions

- **Single-instance server, single workshop in memory.** Multi-workshop visibility is disk-based, not memory-based. Rationale: user explicitly confirmed local-only, no multi-tenant need; simplest model that solves the pain points.
- **Resume-vs-fresh is UI-driven, not agent-driven.** Rationale: after Claude context compaction, the agent loses memory and cannot reliably flag "I am resuming" vs "I am starting fresh." Pushing the decision to the browser modal makes it deterministic and matches the existing pending-load modal pattern.
- **Live state lives in `~/.local/state/agent-workshop/` (XDG_STATE_HOME).** Rationale: it is ephemeral machine-local state, has no business being committed; keeps it out of `.gitignore` drift; eliminates "files in weird places" caused by `process.cwd()`-relative writes. Using `$XDG_STATE_HOME` with the standard fallback is cross-platform-clean on Darwin/Linux (no Windows target).
- **Source YAML stays in project repo.** Rationale: it is a committable artifact — the workshop topic's prepared form — and belongs with the project it describes.
- **Finalize writes *new* files with `.finalized.` in the name; source is untouched.** Rationale: preserves the diff between "as-prepared" and "as-finalized" for audit/history. Source + live + finalized + summary form a 4-file lifecycle.
- **Finalize filenames inherit timestamp and slug from source.** Rationale: alphabetical grouping of related artifacts in `ls`/file browsers; the actual finalize timestamp is recoverable from `mtime` or git log if ever needed.
- **Server auto-shuts-down after finalize with 30s grace period.** Rationale: eliminates zombie servers, the core "läuft dann immer noch"-pain; 30s covers trailing HTTP operations (summary read, chat history fetch) by the same fork before it exits.
- **During grace period, loads are refused with 503.** Rationale: prevents a new workshop from latching onto a dying server and having its session interrupted mid-setup.
- **Multi-workshop overview is a disk scan, switching uses the existing load endpoint.** Rationale: no new server-side state-tracking concepts; the directory IS the registry; the UI composes existing primitives.
- **Server startup idempotency via PID file + port check.** Rationale: prevents the observed "many servers running simultaneously" bug; makes reconnect semantics explicit instead of relying on HTTP ping alone at the skill level.
- **Project root resolved via `git rev-parse --show-toplevel` with `$PWD` fallback.** Rationale: workshop users are almost always in a git repo; fallback keeps the non-git case functional without branching UX.
- **Handoff is paths-in-prompt, not inline content.** Rationale: avoids context bloat from embedding potentially large summaries (especially with chat history); the parent session is instructed to `Read` the file itself, giving the agent full latitude to quote selectively.
- **Fork context is preserved for both skills.** Rationale: the workshop sessions can be very long (many tool calls, large chat history) — folding them into the parent would blow the budget. Paths-in-prompt is the right tradeoff.

## Constraints

- Must keep the single-file Bun server pattern (no build step, server.ts stays self-contained).
- Must stay compatible with non-Claude-Code harnesses (Copilot, Cursor, Windsurf, Codex, OpenCode, Gemini CLI) — the install.sh copies `server.ts` and both `SKILL.md` files into target directories; all changes must work in all harnesses.
- Cannot introduce external dependencies (custom YAML serializer in server.ts stays).
- Must still support context-compaction recovery — the live sidecar's original purpose cannot regress.
- Server continues to use a single fixed port (7892 default, `WORKSHOP_PORT` env override). No dynamic port allocation.
- Must not require any migration of already-existing workshop artifacts in user projects — but existing `docs/workshops/*.workshop.live.yaml` sidecars in project repos will be abandoned (not auto-migrated).
- OS targets remain Darwin and Linux. No Windows path handling.
- Changes to the filename pattern (`YYYY-MM-DD_HH-MM_<slug>` with optional suffixes) are a breaking change to any tooling or muscle memory that parsed the old `YYYY-MM-DD-<slug>` format, but no such tooling has been identified.

## Out of Scope

- True multi-tenant server (multiple workshops concurrently active in memory with distinct URLs or paths). This was explicitly ruled out.
- Remote or cloud deployment (confirmed local-only use case).
- Sharing workshops between users or machines.
- Automatic migration of existing `.workshop.live.yaml` files from project repos to the new user-specific state dir. Users manually clean up on upgrade.
- Automatic rename of existing source YAMLs from old `YYYY-MM-DD-<slug>` to new `YYYY-MM-DD_HH-MM_<slug>` format.
- Upstreaming any lifecycle fixes to the claude-viz plugin (inherits the same `bun run &` pattern, but is a separate plugin with its own release cadence).
- Refactoring the embedded HTML/CSS/JS UI structure beyond what's needed for the workshop overview/switcher and the shutting-down indicator.
- Changes to the REST API's tile/slide/comment data model.
- Garbage collection of old live-state files (e.g., "delete sidecars older than 30 days"). The overview endpoint surfaces them; manual cleanup via the UI is sufficient for V1.
- Cross-platform path handling beyond XDG_STATE_HOME.
- Replacing the fixed-port model with dynamic port allocation.
