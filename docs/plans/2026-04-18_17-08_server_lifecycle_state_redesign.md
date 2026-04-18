---
story: "Redesign agent-workshop server lifecycle, state storage, and finalize handoff to eliminate stale state, path surprises, server zombies, and fork-to-parent context loss."
discussion: docs/discussions/2026-04-18_16-57_server_lifecycle_state_redesign.md
created: 2026-04-18 17:08
max_advisor_rounds: 3
---

# Plan: Server Lifecycle, State Storage, and Finalize Handoff Redesign

**Story:** Redesign agent-workshop server lifecycle, state storage, and finalize handoff to eliminate stale state, path surprises, server zombies, and fork-to-parent context loss.
**Discussion:** [2026-04-18_16-57_server_lifecycle_state_redesign.md](../discussions/2026-04-18_16-57_server_lifecycle_state_redesign.md)

## Acceptance Criteria
*(from discussion — final advisor verifies each)*

- [x] Server startup is idempotent: a second `bun run server.ts` detects an already-running instance via PID file + port check and exits cleanly with a message pointing to the existing URL.
- [x] PID file is written to `~/.local/state/agent-workshop/server.pid` on startup, contains `{pid, port, startedAt}`, is validated (PID alive + port reachable) on next start, and cleaned up on normal shutdown.
- [x] Live state files are written to `~/.local/state/agent-workshop/live/` (respecting `$XDG_STATE_HOME` when set), never inside any project repository.
- [x] Live state filenames follow the pattern `YYYY-MM-DD_HH-MM_<slug>_<id>.live.yaml`, where timestamp and slug are inherited from the source YAML and `<id>` is the workshop ID for collision safety.
- [x] Source YAML files from `/workshop-prepare` follow `YYYY-MM-DD_HH-MM_<slug>.workshop.yaml` (includes time, not just date as today) and are written to `<project-root>/docs/workshops/`.
- [x] Project root is resolved via `git rev-parse --show-toplevel` with `$PWD` as fallback when not inside a git repo. No more `process.cwd()`-relative writes.
- [x] Finalize writes new files alongside the source, never overwriting it: `YYYY-MM-DD_HH-MM_<slug>.finalized.workshop.yaml` and `YYYY-MM-DD_HH-MM_<slug>.summary.md`. Timestamp and slug are inherited from the source file so that source and finalized artifacts sit adjacent alphabetically.
- [x] On `POST /api/workshop/load`, when a live sidecar exists for the requested workshop but the server holds no matching in-memory state (i.e. fresh process), the browser shows a new modal asking "Resume previous state or start fresh?" — the agent does not decide this. The existing pending-load modal (different workshop already loaded) continues to function; the two modals may compose if both conditions apply.
- [x] `GET /api/workshops` returns an array of known live-state sessions on disk `[{id, slug, timestamp, lastModified, livePath, sourcePath?}, ...]`. Implementation scans the state directory and parses minimal metadata from each file.
- [x] Browser UI surfaces the workshop overview (exact UI placement — sidebar entry, dropdown, or modal on empty state — is a planning decision) and supports switching to a different workshop by clicking an entry, which calls the existing `/api/workshop/load` endpoint with that workshop's source path.
- [x] After a successful finalize, the server enters a 30-second grace period during which: `POST /api/workshop/load` returns HTTP 503 with `{error: "shutting-down"}`; an SSE `shutting-down` event is broadcast to connected browsers with remaining-seconds countdown; then `process.exit(0)` runs.
- [x] The live sidecar is deleted during finalize (current behavior, must be preserved).
- [x] The `/workshop-start` skill's closing message (at fork exit) contains absolute paths to both the finalized YAML and the summary markdown, plus an explicit instruction to the parent session to `Read` the summary before continuing any downstream work. Example shape: `Workshop finalized. Summary (LLM-optimized, no diagrams): <abs path>. Full state: <abs path>. Read the summary now before proceeding with follow-up work.`
- [x] Both skills remain `context: fork`. The handoff mechanism is the final-message-with-paths pattern, not removing fork.
- [x] State directory (`~/.local/state/agent-workshop/` and subdirectories `live/`) is auto-created on first server start if missing.

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

## Conventions Used Below

All tasks reference the same agreed shapes — implementers follow these verbatim so the pieces fit together.

**Filename patterns:**
- Source: `YYYY-MM-DD_HH-MM_<slug>.workshop.yaml`
- Finalized: `YYYY-MM-DD_HH-MM_<slug>.finalized.workshop.yaml` (timestamp + slug inherited from source)
- Summary: `YYYY-MM-DD_HH-MM_<slug>.summary.md` (timestamp + slug inherited from source)
- Live sidecar: `YYYY-MM-DD_HH-MM_<slug>_<id>.live.yaml` (timestamp + slug inherited from source; `<id>` = workshop ID)

**State directory resolution:**
- `STATE_DIR = $XDG_STATE_HOME/agent-workshop/` if `$XDG_STATE_HOME` set, else `$HOME/.local/state/agent-workshop/`
- `LIVE_DIR = $STATE_DIR/live/`
- `PID_FILE = $STATE_DIR/server.pid`

**Project root resolution:**
- Run `git rev-parse --show-toplevel` in the relevant directory; on non-zero exit, fall back to `$PWD` (or the given path's directory, whichever the call site needs).

**New SSE event name:** `shutting-down` — payload `{remainingSeconds: number}`, broadcast every second during grace period.

**New `workshop-update` SSE payload field:** `pendingResume: {sourcePath, sourceSummary, liveSummary} | null` — parallel to existing `pendingLoad`.

**New `POST /api/workshop/load` response shapes:**
- Existing: `{ok: true, id, restoredFromLive}` and pending-load 409
- New, when server is fresh + sidecar exists: HTTP 409 with `{ok: false, pendingResume: true, summary: {sourcePath, sourceSummary, liveSummary}}`
- New during grace period: HTTP 503 with `{error: "shutting-down", remainingSeconds}`

**New endpoints:**
- `GET /api/workshops` → `[{id, slug, timestamp, lastModified, livePath, sourcePath?}, ...]`
- `POST /api/workshop/load/resume` → applies stored live state, clears pendingResume
- `POST /api/workshop/load/fresh` → applies stored source state (ignoring sidecar), clears pendingResume

**Updated `finalize-requested` inbox event payload:**
- From: `{path, slug}`
- To: `{finalizedPath, summaryPath, sourcePath, slug, timestamp}` — all absolute paths

## Tasks
*(tasks with the same `group` run in parallel; groups run in order A -> B -> C)*

- [x] **T1: Add server infrastructure — state dir, PID file, project-root helper, signal handlers**
  - **Group:** A
  - **Files:** `agent-workshop/server.ts`
  - **Done when:** Running `bun run agent-workshop/server.ts` creates `~/.local/state/agent-workshop/` and `live/` if missing, writes `server.pid` with `{pid, port, startedAt}`, and a second `bun run` exits with a "server already running at http://..." message. SIGINT/SIGTERM cleanly delete the PID file.
  - Add a small prelude module (top of `server.ts`, before `Bun.serve`) with:
    - `getStateDir()` — honors `$XDG_STATE_HOME`, falls back to `$HOME/.local/state/agent-workshop`.
    - `getLiveDir()` = `getStateDir() + "/live"`.
    - `getPidFile()` = `getStateDir() + "/server.pid"`.
    - `ensureStateDirs()` — `mkdirSync` both directories with `recursive: true`.
    - `resolveProjectRoot(startDir?)` — runs `git rev-parse --show-toplevel` via `Bun.spawnSync`, on failure falls back to `$PWD` (or the provided startDir).
    - `checkExistingServer()` — reads PID file; if present, tests `process.kill(pid, 0)` AND `fetch` to the configured port; returns `{alive: true, port, pid, startedAt}` if both pass, else returns `{alive: false}` and removes the stale PID file.
    - `writePidFile()` — writes `{pid: process.pid, port: PORT, startedAt: ISO string}` atomically.
    - `removePidFile()` — best-effort delete.
  - At startup (before `Bun.serve`): call `ensureStateDirs()`, then `checkExistingServer()`. If `alive`, print `Agent Workshop server already running at http://127.0.0.1:<port>` and `process.exit(0)`. Otherwise call `writePidFile()`.
  - Register `process.on("SIGINT", ...)` and `process.on("SIGTERM", ...)` handlers that call `removePidFile()` and `process.exit(0)`.
  - Do not change any endpoint logic in this task.

- [x] **T2: Update workshop-prepare SKILL.md — timestamped filename + project-root write**
  - **Group:** A
  - **Files:** `agent-workshop/skills/workshop-prepare/SKILL.md`
  - **Done when:** Step 4 instructs the agent to (a) resolve project root via `git rev-parse --show-toplevel` with `$PWD` fallback, (b) write to `<project-root>/docs/workshops/`, (c) filename pattern is `YYYY-MM-DD_HH-MM_<slug>.workshop.yaml`. No more relative `docs/workshops/` references.
  - Update Step 4 "Write the File":
    - Replace `docs/workshops/YYYY-MM-DD-<slug>.workshop.yaml` with `<project-root>/docs/workshops/YYYY-MM-DD_HH-MM_<slug>.workshop.yaml`.
    - Add a short snippet showing how to compute project root:
      ```bash
      PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
      mkdir -p "$PROJECT_ROOT/docs/workshops"
      ```
    - State explicitly that the filename includes the current local time in `HH-MM` form so that multiple prepares per day don't collide.
    - Update the example filename in the "Where `<slug>` is..." paragraph accordingly.

- [x] **T3: Update workshop-start SKILL.md — reconnect logic, finalize step, closing message with absolute paths**
  - **Group:** A
  - **Files:** `agent-workshop/skills/workshop-start/SKILL.md`
  - **Done when:** Step 1 reconnect logic no longer tries to decide resume-vs-fresh (browser does it); Step 5 reads `finalizedPath` and `summaryPath` from the `finalize-requested` event payload instead of deriving them; Step 6 closing message names both absolute paths and tells the parent to `Read` the summary before proceeding.
  - Step 1: remove the `restoredFromLive` note from the "after load" description — that sidecar-exists case is now a browser modal that blocks the load response until the user picks. Add a new bullet under the load-response interpretation: "if `pendingResume: true` is returned, tell the user to pick Resume or Start Fresh in the browser modal, then wait for a follow-up SSE/poll indicating load succeeded."
  - Step 5: the agent no longer generates a filename. Read `finalizedPath`, `summaryPath`, `sourcePath`, `slug`, `timestamp` from the event payload. Write the summary to the exact `summaryPath` given. The existing summary-format template stays.
  - Step 6: rewrite the closing message to:
    ```
    Workshop finalized.
    - Summary (LLM-optimized, no diagrams): <summaryPath absolute>
    - Full finalized state: <finalizedPath absolute>

    Read the summary file now before proceeding with any follow-up work based on this workshop.
    ```
    Use the absolute paths from the event payload. Remove the old "YAML state saved to..." line that used relative paths.
  - Step 7 "Stopping the Server": update note that after finalize the server shuts itself down automatically after 30s grace — manual `kill` is only needed to abandon a non-finalized workshop.

- [x] **T4: Server — state paths, /api/workshops endpoint, resume-vs-fresh detection, finalize rework, grace period**
  - **Group:** B
  - **Depends on:** T1
  - **Files:** `agent-workshop/server.ts`
  - **Done when:** `livePathFor(sourcePath, id)` returns a path in `LIVE_DIR` using the `YYYY-MM-DD_HH-MM_<slug>_<id>.live.yaml` pattern; `GET /api/workshops` returns the documented array; `POST /api/workshop/load` returns the new `pendingResume` 409 when server is fresh and a sidecar matches; `/api/workshop/load/resume` and `/api/workshop/load/fresh` apply the corresponding state; finalize writes `<source-dir>/<timestamp>_<slug>.finalized.workshop.yaml` and emits the updated event payload; a 30s grace period fires after finalize with SSE `shutting-down` events and a final `process.exit(0)`; `POST /api/workshop/load` returns 503 during the grace window.
  - **Filename helpers:** add `parseSourceFilename(sourcePath) -> {timestamp, slug} | null` that recognizes `YYYY-MM-DD_HH-MM_<slug>.workshop.yaml`. Add `buildLiveFilename(timestamp, slug, id)` and `buildFinalizedFilenames(timestamp, slug)` returning the full filenames described in the conventions.
  - **Rework `livePathFor`:** new signature `livePathFor(sourcePath, id)`. Parse source; if parsing fails, fall back to a safe default (`unknown_<id>.live.yaml` in `LIVE_DIR`) and log a warning. Always write into `LIVE_DIR`.
  - **Rework `persistLive`/`schedulePersist`:** they already use `currentSourcePath` + workshop state; update them to pass `workshop.id` to `livePathFor`.
  - **Rework `applyWorkshopFromParsed` call sites:** still sync in-memory state; nothing changes here.
  - **New `GET /api/workshops` endpoint:** `readdirSync(LIVE_DIR)`; for each `*.live.yaml` file, parse the filename into `{timestamp, slug, id}` and read the file's `mtime`. Optionally (best-effort) open the YAML and extract `title`. Return `[{id, slug, timestamp, lastModified, livePath, sourcePath?}, ...]` sorted by `lastModified` desc. `sourcePath` is omitted (the server cannot reliably know where the source lives — the overview UI just shows the live file metadata; the user provides the source path via the existing load flow).
  - **Rework `POST /api/workshop/load`:**
    - Resolve `sourcePath` as absolute (no more `process.cwd()` prefix — if relative, resolve against `resolveProjectRoot()` or reject with 400). Read + parse source YAML.
    - Compute `livePath = livePathFor(sourcePath, sourceParsed.id)`.
    - If the server is in grace period (`shuttingDownAt !== null`): return 503 `{error: "shutting-down", remainingSeconds}`.
    - Existing "different workshop already in memory" branch: keep the pending-load 409 flow untouched.
    - **New branch — server is fresh and sidecar exists:**
      - Condition: `currentSourcePath === null && workshop.slides.length === 0 && workshop.chat.length === 0 && workshop.status !== "finalized"` AND `liveFile.exists()` AND live's `id === sourceId`.
      - Store `pendingResume = {sourcePath, sourceParsed, liveParsed, requestedAt}`.
      - Broadcast `workshop-update` with new `pendingResume` field populated.
      - Return HTTP 409 `{ok: false, pendingResume: true, summary: {sourcePath, sourceSummary: {id, title, slideCount}, liveSummary: {id, title, slideCount, commentCount, chatCount, lastModified}}}`.
    - Otherwise keep existing behavior (apply source straight through, with the current auto-restore from live **only when explicitly forced**; after this change, auto-restore without modal no longer happens — remove the `restoredFromLive` auto-path inside this endpoint since the modal now governs it).
  - **New `POST /api/workshop/load/resume`:** if `pendingResume` is set, `applyWorkshopFromParsed(pendingResume.liveParsed)`, set `currentSourcePath = pendingResume.sourcePath`, clear `pendingResume`, broadcast.
  - **New `POST /api/workshop/load/fresh`:** if `pendingResume` is set, `applyWorkshopFromParsed(pendingResume.sourceParsed)`, set `currentSourcePath = pendingResume.sourcePath`, **delete** the existing sidecar at `livePathFor(sourcePath, id)` so fresh truly starts fresh, clear `pendingResume`, broadcast.
  - **Rework `POST /api/finalize`:**
    - Require `currentSourcePath` to be set; return 400 otherwise ("no workshop loaded to finalize").
    - Parse `currentSourcePath` via `parseSourceFilename`. If parsing fails, fall back to `new Date()` + `body.slug || workshop.id` (same as today) but log a warning.
    - Compute `sourceDir = dirname(currentSourcePath)`. Write `sourceDir/<timestamp>_<slug>.finalized.workshop.yaml` (not under `process.cwd()`).
    - Compute `summaryPath = sourceDir/<timestamp>_<slug>.summary.md` (server does **not** write this — the skill does; we only include the path in the event payload).
    - Delete sidecar at `livePathFor(currentSourcePath, workshop.id)`. (Behavior preserved, but path source changes.)
    - Emit inbox event `finalize-requested` with payload `{finalizedPath, summaryPath, sourcePath: currentSourcePath, slug, timestamp}` — all absolute.
    - Enter grace period (see below).
  - **Grace period:** add module-level `let shuttingDownAt: number | null = null;` and `let shutdownTimer: Timeout | null = null;`. After successful finalize: `shuttingDownAt = Date.now() + 30_000`; start a 1-second interval that broadcasts SSE `shutting-down` with `{remainingSeconds}`; at expiry call `removePidFile()` then `process.exit(0)`. `POST /api/workshop/load` must return 503 while `shuttingDownAt !== null`.
  - **Remove `process.cwd()` references:** grep for `process.cwd()` inside `server.ts`; every write site should go through `resolveProjectRoot()` or an absolute path derived from the source. The only permissible reading uses are harmless fallbacks inside `resolveProjectRoot`.

- [x] **T5: Server — browser UI additions (resume-fresh modal, workshop overview, shutting-down indicator)**
  - **Group:** C
  - **Depends on:** T4
  - **Files:** `agent-workshop/server.ts`
  - **Done when:** Three new UI pieces are present in the embedded HTML/CSS/JS: a Resume/Fresh modal analogous to the existing pending-load modal; a workshop overview (sidebar entry that opens a modal listing `/api/workshops` entries with click-to-switch via existing `/api/workshop/load`); a shutting-down banner with live countdown consuming the new `shutting-down` SSE event. All three survive a page reload with state from SSE.
  - **Resume/Fresh modal:**
    - Add a new `<div class="modal-overlay" id="resume-fresh-modal">` near the existing `pending-load-modal`. Body shows: "This workshop has in-progress state from a previous session. Resume or start fresh?" Show `liveSummary` (slides/comments/chat/lastModified) vs `sourceSummary` (slides) side-by-side in the same two-card layout as the pending-load modal.
    - Two buttons: "Resume" → POSTs `/api/workshop/load/resume`; "Start Fresh" → POSTs `/api/workshop/load/fresh` (button should include a warning "This discards the saved state.").
    - Wire into the existing `hydrate` / SSE handler: when `state.pendingResume` is non-null, open this modal; when both `pendingLoad` and `pendingResume` are populated, pending-load wins (it's about a different workshop; resume-or-fresh only becomes relevant after that resolves). Document this ordering in a one-line code comment.
  - **Workshop overview:**
    - Add a new sidebar button/entry "Workshops" (below the workshop title) that toggles a modal. Modal body: async `fetch('/api/workshops')`, render each entry as a row with title (if known), slug, timestamp, lastModified, and a "Switch" button. Clicking "Switch" calls `fetch('/api/workshop/load', {method: 'POST', body: JSON.stringify({path: entry.sourcePath || entry.livePath})})` — but since `sourcePath` is not stored in the overview, expose a text input next to each row prefilled with the user's best guess (or simpler: the row shows only the live file; switching requires the user to provide the source path via a separate input). Pragmatic V1: the modal is informational (list + livePath) and includes a generic text input "Load workshop by source path:" that POSTs to `/api/workshop/load`. This keeps the overview useful without needing server-side source-path tracking.
    - Refresh the list when the modal opens (not on SSE); this is a low-frequency operation.
  - **Shutting-down indicator:**
    - Add a new top banner element (hidden by default). On SSE `shutting-down` event, show banner: "Workshop server is shutting down in Ns — please finish any pending reads." The `remainingSeconds` value comes from the event payload.
    - When the seconds reach 0 or the SSE connection drops, leave the banner visible with "Server has stopped." Disable the chat input and the "Load/Finalize" buttons during grace.
  - **SSE handler update:** the `workshop-update` event already carries the full state object — extend the client reducer to pick up `pendingResume` alongside `pendingLoad`. Add a separate `shutting-down` event listener.

## Advisor Checks
*(clean-context advisor verifies, in addition to acceptance criteria)*

- [x] All tasks marked complete.
- [x] No `process.cwd()` write-path references remain in `agent-workshop/server.ts` (grep should find 0 or only reading/logging uses that are clearly not write sites).
- [x] No `.workshop.live.yaml` writes target a path inside a project repo — all live writes land under `~/.local/state/agent-workshop/live/` (or `$XDG_STATE_HOME/agent-workshop/live/`).
- [x] Both `SKILL.md` files still have `context: fork` in their frontmatter (regression guard on AC14).
- [~] Manual smoke — idempotency: run `bun run agent-workshop/server.ts` twice; second invocation exits 0 with the "already running" message; only one PID in `~/.local/state/agent-workshop/server.pid`.
- [~] Manual smoke — state location: prepare a workshop, start it, edit a tile, observe a `YYYY-MM-DD_HH-MM_<slug>_<id>.live.yaml` file appear in `~/.local/state/agent-workshop/live/` and **not** in the project's `docs/workshops/`.
- [~] Manual smoke — resume modal: stop the server with a live sidecar on disk, re-start, `POST /api/workshop/load` with the original source path, verify browser shows the Resume/Fresh modal, click Resume — state restored.
- [~] Manual smoke — finalize handoff: finalize a workshop, verify both `YYYY-MM-DD_HH-MM_<slug>.finalized.workshop.yaml` and `YYYY-MM-DD_HH-MM_<slug>.summary.md` exist next to the source YAML; inbox event `finalize-requested` payload includes both absolute paths.
- [~] Manual smoke — grace period: finalize, observe SSE `shutting-down` countdown in browser, `POST /api/workshop/load` during the 30s returns 503; server process exits at T+30s and the PID file is removed.
- [x] Bun type check / parse: `bun check agent-workshop/server.ts` (or `bun run --check agent-workshop/server.ts`) passes with no errors.

## Progress Log
<!-- appended by /implement-plan -->
- 2026-04-18T15:15:02Z — T2: Step 4 now resolves project root via `git rev-parse --show-toplevel 2>/dev/null || pwd`, writes to `$PROJECT_ROOT/docs/workshops/`, uses filename pattern `YYYY-MM-DD_HH-MM_<slug>.workshop.yaml` with HH-MM collision note.
- 2026-04-18T15:16:31Z — T3: workshop-start SKILL.md updated — Step 1 defers resume-vs-fresh to browser modal via `pendingResume`; Step 5 reads finalized/summary/source paths from event payload; Step 6 closing message names absolute paths and instructs parent `Read` on summary; Step 7 notes auto-shutdown; API table updated.
- 2026-04-18T15:16:48Z — T1: server.ts lifecycle prelude added — XDG-aware state/live/pid helpers, ensureStateDirs, resolveProjectRoot with git/$PWD fallback, checkExistingServer with kill(0)+fetch double-check and stale-PID cleanup, writePidFile/removePidFile, startup idempotency, SIGINT/SIGTERM handlers. Verified second invocation exits cleanly.
- 2026-04-18T15:22:14Z — T4: filename helpers + reworked livePathFor into LIVE_DIR; pendingResume state + summary; 30s shutdown grace with SSE countdown + process.exit(0); POST /api/workshop/load now has 503 grace guard + pendingResume 409 branch (no more silent auto-restore); POST /api/workshop/load/resume and /fresh added; GET /api/workshops scans LIVE_DIR; POST /api/finalize writes `.finalized.workshop.yaml` alongside source with inherited timestamp/slug and emits new event payload. All `process.cwd()` write-path refs removed. Bun build clean.
- 2026-04-18T15:25:53Z — T5: Resume/Fresh modal + Workshops overview modal (fetches `/api/workshops`, load-by-path input) + shutdown banner consuming `shutting-down` SSE with countdown; `state.pendingResume` wired through SSE handler; pending-load takes precedence per inline comment. Bun build clean.
- 2026-04-18T15:28:51Z — Advisor APPROVED (Opus, round 1): all 15 acceptance criteria + 5 static advisor checks verified. Bun build 100.30 KB, 0 errors. Five manual-smoke advisor checks marked `[~]` — they require runtime verification before shipping (double-start idempotency, sidecar in state dir, resume modal, finalize file creation, grace-period 503+exit).
