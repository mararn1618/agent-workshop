---
story: "Build Agentic Workshop — a browser-based, slide-driven alignment tool where the agent prepares a structured workshop asynchronously and then guides the user through it interactively"
discussion: docs/discussions/2026-04-16-agentic-workshop.md
created: 2026-04-16
max_advisor_rounds: 3
---

# Plan: Agentic Workshop

**Story:** Build Agentic Workshop — a browser-based, slide-driven alignment tool where the agent prepares a structured workshop asynchronously and then guides the user through it interactively.
**Discussion:** [2026-04-16-agentic-workshop.md](../discussions/2026-04-16-agentic-workshop.md)

## Acceptance Criteria
*(from discussion — final advisor verifies each)*

- [ ] Workshop file format defined as TypeScript types with YAML serialization on disk
- [ ] `/workshop-prepare` command: agent takes free-form input, gathers context, produces a `.workshop.yaml` file in `docs/workshops/`
- [ ] `/workshop-start` command: loads existing workshop YAML (or runs prepare first if none exists), starts server, pushes slides to browser, enters interactive mode
- [ ] Server extends claude-viz: Bun single-file server with REST API + SSE
- [ ] Agent communicates with server via curl (auto-approved through skill `allowed-tools`)
- [ ] UI layout: sidebar (slide navigation) + center (active slide with tiles) + right panel (general chat, resizable width)
- [ ] Tile types supported: markdown, mermaid, kroki, html, svg (same as claude-viz cards)
- [ ] Tile comment system: user can comment on any tile; comments are appended by default, user can then edit, remove, or apply; apply sends notification to agent inbox
- [ ] Question-tiles: no separate type — agent creates a tile intended to be commented on, user responds via the standard comment mechanism
- [ ] General chat panel (not per-slide): free-form conversation between user and agent
- [ ] Session-scoped server inbox: browser POSTs user events, agent polls to consume; events marked as consumed, never deleted
- [ ] Agent can push slides, update slides, remove slides, update individual tiles, post chat messages, poll inbox
- [ ] Single "Finalize Workshop" button: server writes full workshop state YAML to disk, agent reads it and produces a curated summary markdown alongside it
- [ ] Both artifacts written to `docs/workshops/`: `YYYY-MM-DD-<slug>.workshop.yaml` (full state) and `YYYY-MM-DD-<slug>.summary.md` (agent-curated summary)
- [ ] Skill packaged as a self-contained plugin: `plugin.json` + `server.ts` + command markdown files + TypeScript type definitions

## Out of Scope
- Export/import from browser UI (future — design state model to support it, but don't build the UI)
- Break/resume for long workshops (solvable later via export/import)
- MCP server transport (future alternative to curl)
- Per-slide approval workflow (single finalize button is sufficient)
- Multi-user / team collaboration
- Cloud hosting / shared workshops
- Integration with issue trackers (GitHub Issues / TickTick stay as separate entry points)
- Rich text editing in chat or comments
- Image generation in tiles
- Multiple concurrent workshops
- Workshop templates
- Dependency on other skills (discuss-plan-implement, plannotator, etc.)

## Architecture Reference

The five-layer architecture (from `docs/context/agentic-workshop-handoff/02-architecture-layers.md`):

```
Layer 1: File Format     — types.ts + YAML serialization          (T1)
Layer 2: User Interaction — embedded browser UI in server.ts       (T3)
Layer 3: Infrastructure   — Bun server, REST API, SSE, inbox      (T3)
Layer 4: Agent API        — curl-callable REST endpoints           (T3)
Layer 5: Agent Skill      — SKILL.md command files                 (T4, T5)
```

Existing reference: `claude-viz` at `/Users/work1618/.claude/plugins/marketplaces/mararn1618-claude-marketplace/claude-viz/` — same Bun single-file server pattern, same sidebar+cards UI, same SSE broadcast. The workshop server extends this architecture with bidirectional communication (chat, tile comments, inbox) and a workshop lifecycle.

## Tasks
*(tasks with the same `group` run in parallel; groups run in order A -> B -> C -> D)*

- [x] **T1: Define TypeScript type definitions**
  - **Group:** A
  - **Files:** `types.ts`
  - **Done when:** types compile with `bun build types.ts` and match the agreed schema — Workshop with slides[], each slide with tiles[], each tile with comments[], plus ChatMessage[], InboxEvent, and all status enums
  - Define all data model interfaces: `Workshop` (id, title, description, status, created, slides, chat), `Slide` (id, title, order, tiles), `Tile` (id, type, title, content, size, comments, krokiDiagramType, krokiOutputFormat), `Comment` (id, author, content, status, createdAt, appliedAt), `ChatMessage` (id, author, content, createdAt), `InboxEvent` (id, type, payload, createdAt, consumed, consumedAt). Export all types. Include literal union types for WorkshopStatus (`"preparing" | "ready" | "active" | "finalized"`), TileType (`"markdown" | "mermaid" | "kroki" | "html" | "svg"`), CommentStatus (`"pending" | "applied" | "removed"`), InboxEventType (comment-applied, chat-message, etc.). These types are the single source of truth — the server imports them directly.

- [x] **T2: Create plugin skeleton and directory structure**
  - **Group:** A
  - **Files:** `.claude-plugin/plugin.json`, `skills/workshop-prepare/SKILL.md` (placeholder), `skills/workshop-start/SKILL.md` (placeholder)
  - **Done when:** `plugin.json` is valid JSON following the claude-viz pattern, skill directories exist with placeholder files
  - Create `.claude-plugin/plugin.json` with name `"agentic-workshop"`, description, version `"0.1.0"`, author. Create `skills/workshop-prepare/` and `skills/workshop-start/` directories with minimal placeholder SKILL.md files (just frontmatter — full content is T4/T5). Reference claude-viz's plugin.json (`/Users/work1618/.claude/plugins/marketplaces/mararn1618-claude-marketplace/claude-viz/.claude-plugin/plugin.json`) for the exact format.

- [x] **T3: Build Bun server with REST API, embedded UI, and YAML I/O**
  - **Group:** B
  - **Depends on:** T1
  - **Files:** `server.ts`
  - **Done when:** server starts on port 7892, all REST API endpoints respond correctly to curl, browser renders sidebar with slide navigation + center area with tiles + right chat panel, SSE streams updates, YAML load and finalize work end-to-end
  - This is the core of the project — a single-file Bun server following the claude-viz pattern (`/Users/work1618/.claude/plugins/marketplaces/mararn1618-claude-marketplace/claude-viz/server.ts`). Import types from `types.ts`. The server has three major parts:
  - **Backend:** In-memory workshop state. REST API endpoints: `POST /api/workshop/load` (load from YAML path), `POST /api/slides` (push slide), `PUT /api/slides/:id` (update slide), `DELETE /api/slides/:id` (remove slide), `POST /api/slides/:slideId/tiles` (add tile), `PUT /api/slides/:slideId/tiles/:tileId` (update tile), `POST /api/chat` (post message — body has `author` and `content`), `GET /api/chat` (get chat history), `POST /api/tiles/:tileId/comments` (add comment from browser), `PUT /api/tiles/:tileId/comments/:commentId` (update comment status — edit, apply, remove), `GET /api/inbox` (poll — query param `unconsumed=true`), `POST /api/inbox/:id/consume` (mark consumed), `POST /api/finalize` (write YAML to disk at specified path), `GET /api/health`, `GET /api/events` (SSE). When a comment is "applied", auto-create an inbox event. CORS headers on all responses.
  - **UI (embedded HTML/CSS/JS):** Dark GitHub-style theme matching claude-viz. Three-panel layout: left sidebar (slide navigation — title list, click to select, active highlight), center (active slide title + 2-column tile grid with tile rendering for all 5 types), right panel (general chat — message list + input, resizable width via drag handle). Each tile has: header with type badge, content area with appropriate renderer (reuse claude-viz rendering patterns for mermaid/kroki/markdown/html/svg including zoom/pan for diagrams), and a comment affordance (toggle to show/add comments, each comment shows status, edit/remove/apply buttons). "Finalize Workshop" button in the sidebar footer. All user interactions (comment apply, chat send, finalize) POST to server which creates inbox events. SSE connection for live updates — re-render affected UI on server push.
  - **YAML I/O:** Load workshop from a `.workshop.yaml` file path (parse YAML, populate in-memory state, broadcast to SSE). Finalize writes the full workshop state to a YAML file at the agent-specified path. Use a YAML library (e.g., `js-yaml` via `bun add js-yaml`) or Bun's built-in capabilities if available.
  - Default port 7892 (configurable via `WORKSHOP_PORT` env var) to avoid clashing with claude-viz on 7891.

- [x] **T4: Write `/workshop-prepare` skill**
  - **Group:** C
  - **Depends on:** T3
  - **Files:** `skills/workshop-prepare/SKILL.md`
  - **Done when:** SKILL.md has valid frontmatter (description, `context: fork`, `allowed-tools` including `Bash(curl *)`, `Read`, `Grep`, `Glob`), complete agent instructions covering the full preparation workflow, and matches the claude-viz SKILL.md authoring pattern
  - Write the skill that teaches the agent how to prepare a workshop asynchronously. The agent's workflow: (1) read the user's input (task description, issue URL, or free-form context), (2) gather project context using Read/Grep/Glob, (3) structure findings into slides — one topic per slide, tiles within each slide for text/diagrams/questions, (4) serialize as YAML matching the TypeScript types, (5) write to `docs/workshops/YYYY-MM-DD-<slug>.workshop.yaml`. Include guidance on slide granularity ("one thought unit per slide"), tile type selection (when to use mermaid vs kroki vs markdown), and how to place question-tiles where they make contextual sense (not front-loaded). Reference the YAML file format and TypeScript types. The skill should NOT start the server or open the browser — that's `/workshop-start`.

- [x] **T5: Write `/workshop-start` skill**
  - **Group:** C
  - **Depends on:** T3
  - **Files:** `skills/workshop-start/SKILL.md`
  - **Done when:** SKILL.md has valid frontmatter (description, `context: fork`, `allowed-tools` including `Bash(curl *)`, `Bash(bun *)`, `Bash(open *)`, `Bash(kill *)`, `Bash(lsof *)`, `Read`, `Grep`, `Glob`), complete agent instructions covering server startup, slide loading, the interactive polling loop, and finalization
  - Write the skill that teaches the agent how to present a workshop interactively. The agent's workflow: (1) check if a workshop YAML exists (if not, run prepare first), (2) start the server (`bun run SKILL_BASE_DIR/../../server.ts &`), (3) load the workshop via `curl POST /api/workshop/load`, (4) open the browser, (5) enter the interactive loop — poll `GET /api/inbox?unconsumed=true` every few seconds, respond to events: for chat messages, reply via `POST /api/chat`; for applied comments, update the relevant tile via `PUT /api/slides/:slideId/tiles/:tileId` and post acknowledgment in chat; (6) on finalize event, read the exported YAML file and write a curated summary to `docs/workshops/YYYY-MM-DD-<slug>.summary.md`. The summary replaces diagram/SVG content with placeholders so it's suitable as LLM context. Include the full curl API reference (all endpoints with examples) so the agent has everything it needs without reading server.ts. Reference the claude-viz start skill (`/Users/work1618/.claude/plugins/marketplaces/mararn1618-claude-marketplace/claude-viz/skills/viz-start/SKILL.md`) for the startup pattern.

## Advisor Checks
*(clean-context advisor verifies, in addition to acceptance criteria)*

- [x] All tasks marked complete
- [x] `bun run server.ts` starts without errors on port 7892
- [x] `curl POST /api/slides` creates a slide visible in the browser sidebar
- [x] `curl POST /api/chat` message appears in the browser chat panel
- [x] Adding a comment on a tile in the browser creates an inbox event retrievable via `curl GET /api/inbox?unconsumed=true`
- [x] Applying a comment triggers an inbox event with type `comment-applied`
- [x] `curl POST /api/finalize` writes a valid `.workshop.yaml` file to disk
- [x] Both SKILL.md files have valid frontmatter with `allowed-tools` including `Bash(curl *)`
- [x] No dependency on claude-viz, discuss-plan-implement, or any other plugin — fully self-contained
- [x] TypeScript types in `types.ts` are imported and used by `server.ts` (not duplicated)
- [x] Plugin structure matches claude-viz pattern: `.claude-plugin/plugin.json` + `server.ts` + `skills/` directories

## Progress Log
<!-- appended by /implement-plan -->
- 2026-04-16T12:53Z — T1: Created types.ts with all interfaces (Workshop, Slide, Tile, Comment, ChatMessage, InboxEvent) and literal unions. Fixed size to "full"|"half", author to "user"|"agent", optional title/description.
- 2026-04-16T12:53Z — T2: Created .claude-plugin/plugin.json and placeholder SKILL.md files in skills/workshop-prepare/ and skills/workshop-start/.
- 2026-04-16T13:00Z — T3: Built server.ts (1753 lines) — full Bun server with all REST API endpoints, embedded three-panel UI, SSE, inline YAML serializer, finalize flow. Tested via curl.
- 2026-04-16T13:03Z — T4: Wrote workshop-prepare SKILL.md — full preparation workflow with YAML schema, tile guidance, question-scattering discipline.
- 2026-04-16T13:03Z — T5: Wrote workshop-start SKILL.md — full interactive loop with server startup, YAML loading, inbox polling, finalization, API reference table.
- 2026-04-16T13:08Z — Advisor APPROVED (Round 2): Fixed missing `comment-added` InboxEventType in types.ts and corresponding inbox event creation in server.ts POST /api/tiles/:tileId/comments. All 10 advisor checks pass.
