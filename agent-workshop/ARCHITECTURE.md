# Agent Workshop — Architecture

This document is intended for agents and developers picking up work on the plugin. It covers the full architecture, file layout, data flow, and extension points.

## Project structure

```
.
├── .claude-plugin/
│   └── plugin.json            # Plugin metadata (name, version, author)
├── server.ts                  # Single-file Bun server (~1900 lines): REST API + embedded UI + YAML I/O
├── types.ts                   # TypeScript type definitions — single source of truth for the data model
├── skills/
│   ├── workshop-prepare/
│   │   └── SKILL.md           # Agent skill: gather context, structure slides, write .workshop.yaml
│   └── workshop-start/
│       └── SKILL.md           # Agent skill: start server, load workshop, run interactive polling loop
└── docs/
    ├── ARCHITECTURE.md         # This file
    └── workshops/              # Output directory for workshop YAML and summary files
```

## Five-layer architecture

```
Layer 5: Agent Skill     — SKILL.md files teach the agent the workflow
Layer 4: Agent API       — curl-callable REST endpoints (auto-approved via allowed-tools)
Layer 3: Infrastructure  — Bun server, REST API, SSE broadcast, inbox event system
Layer 2: Browser UI      — Embedded HTML/CSS/JS: sidebar + tile grid + chat panel
Layer 1: File Format     — TypeScript types (types.ts) + YAML serialization on disk
```

Coupling is one-directional upward. The file format never depends on the UI; the UI never depends on the skill instructions.

## Data model (types.ts)

All types are defined in `types.ts` and imported by `server.ts`. Never duplicate types — this file is the single source of truth.

### Core types

| Type | Key fields | Notes |
|------|-----------|-------|
| `Workshop` | id, title, description?, status, created, slides[], chat[] | Top-level container |
| `Slide` | id, title, order, tiles[] | One topic per slide |
| `Tile` | id, type, title?, content, size, comments[], krokiDiagramType?, krokiOutputFormat? | Renderable unit within a slide |
| `Comment` | id, author, content, status, createdAt, appliedAt? | User/agent feedback on a tile |
| `ChatMessage` | id, author, content, createdAt | General conversation |
| `InboxEvent` | id, type, payload, createdAt, consumed, consumedAt? | Server-to-agent notification |

### Enums (literal unions)

| Type | Values |
|------|--------|
| `WorkshopStatus` | `preparing`, `ready`, `active`, `finalized` |
| `TileType` | `markdown`, `mermaid`, `kroki`, `html`, `svg` |
| `CommentStatus` | `pending`, `applied`, `removed` |
| `InboxEventType` | `comment-applied`, `chat-message`, `finalize-requested` |

## Server (server.ts)

Single-file Bun server following the claude-viz pattern. Port 7892 (configurable via `WORKSHOP_PORT` env var), host 127.0.0.1 (`WORKSHOP_HOST`).

### Major sections (by line range)

| Section | Description |
|---------|-------------|
| In-memory state (~23-70) | Workshop object, inbox array, SSE client set, helper functions |
| YAML serializer (~71-367) | Custom inline YAML serializer/deserializer (no external dependencies) |
| CORS helper (~368-384) | Adds CORS headers to all responses |
| Embedded HTML/CSS/JS (~385-1465) | Full browser UI as a template string |
| HTTP server (~1466-1906) | Bun.serve with all REST API route handlers |

### REST API

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/health | Health check: status, slide count, chat count, current source path, pending-load flag |
| GET | /api/workshop | Full workshop state |
| POST | /api/workshop/load | Load workshop from a YAML file path on disk (auto-restores from live sidecar; 409 if a different workshop is active) |
| POST | /api/workshop/load/confirm | Apply a pending load (user clicked Accept in browser) |
| POST | /api/workshop/load/cancel | Decline a pending load (user clicked Decline in browser) |
| POST | /api/slides | Push a new slide |
| PUT | /api/slides/:id | Update a slide |
| DELETE | /api/slides/:id | Remove a slide |
| POST | /api/slides/:slideId/tiles | Add a tile to a slide |
| PUT | /api/slides/:slideId/tiles/:tileId | Update a tile |
| POST | /api/chat | Post a chat message (body: `{author, content}`) |
| GET | /api/chat | Get chat history |
| POST | /api/tiles/:tileId/comments | Add a comment to a tile |
| PUT | /api/tiles/:tileId/comments/:commentId | Update comment (status, content) |
| GET | /api/inbox | Poll inbox (query: `?unconsumed=true`) |
| POST | /api/inbox/:id/consume | Mark an inbox event as consumed |
| POST | /api/finalize | Write full workshop state to YAML on disk |
| GET | /api/events | SSE stream for live browser updates |

### SSE (Server-Sent Events)

The server broadcasts a `workshop-update` event to all connected browsers whenever state changes. The event payload is `{ workshop, inbox }`. The browser UI listens on `EventSource('/api/events')` and re-renders on each update.

### Inbox event system

The inbox is a session-scoped, append-only event queue. Events are created automatically by the server when:
- A user posts a chat message (`chat-message`)
- A user applies a comment (`comment-applied`)
- The finalize endpoint is called (`finalize-requested`)

Adding a comment stores it in tile state (`pending`) but does NOT emit an inbox event — the agent only reacts once the user clicks Apply.

Events are never deleted, only marked as consumed. The agent polls `GET /api/inbox?unconsumed=true` and processes events, then marks them consumed via `POST /api/inbox/:id/consume`.

### YAML I/O

The server includes a custom inline YAML serializer and deserializer — no external dependencies (no js-yaml). This keeps the server fully self-contained as a single file.

- **Load**: `POST /api/workshop/load` reads a `.workshop.yaml` file from disk, parses it, and populates in-memory state.
- **Finalize**: `POST /api/finalize` serializes the current workshop state to YAML and writes it to `docs/workshops/`.

### Live-state persistence (compaction-safe)

On every state mutation (tile update, comment add/apply, chat post, slide change, inbox event), the server debounces a write (300ms) of the full in-memory state — workshop, comments, chat, AND the inbox — to a sidecar file next to the source YAML:

```
docs/workshops/my-workshop.workshop.yaml         ← source (never modified during session)
docs/workshops/my-workshop.workshop.live.yaml    ← live sidecar (overwritten on every change)
```

When `/api/workshop/load` is called, it checks for a live sidecar whose `id` matches the source YAML's `id`. If present, the server loads the sidecar instead — preserving all in-progress state. This makes the session resilient to agent context compaction: if the agent restarts and dutifully re-runs load, the live state is automatically restored (response includes `restoredFromLive: true`).

On `/api/finalize`, the live sidecar is deleted — the finalized YAML in `docs/workshops/` is the source of truth from that point on, and a stale sidecar must not linger and resurrect post-finalize state on the next load.

### Safe-load and pending-load confirmation

`POST /api/workshop/load` refuses to silently overwrite an active workshop with a different one. If the currently-loaded workshop has a different `id` than the one being loaded:

1. The server stashes the parsed new workshop in a `pendingLoad` slot and returns HTTP 409 with `{pending: true, summary: {...}}`.
2. A `workshop-update` SSE event broadcasts the pending-load summary (current title + counts, requested title + counts).
3. The browser displays a modal asking the user to accept or decline.
4. The user accepts → `POST /api/workshop/load/confirm` applies the pending load.
5. The user declines → `POST /api/workshop/load/cancel` clears the pending slot; the current workshop stays untouched.

Agents can bypass the confirmation by passing `force: true` in the load body, but the default should always require user confirmation for a disruptive overwrite.

## Browser UI

The UI is embedded directly in `server.ts` as an HTML template string. Three-panel layout:

```
┌──────────┬────────────────────────┬──────────────┐
│ Sidebar  │    Tile Grid           │  Chat Panel  │
│          │                        │              │
│ Slide 1  │  ┌──────┐ ┌──────┐    │  Messages    │
│ Slide 2  │  │Tile 1│ │Tile 2│    │              │
│ Slide 3  │  └──────┘ └──────┘    │              │
│ ...      │  ┌──────────────┐     │              │
│          │  │   Tile 3     │     │  ┌────────┐  │
│          │  └──────────────┘     │  │ Input  │  │
│ Finalize │                        │  │ Send   │  │
└──────────┴────────────────────────┴──────────────┘
```

- **Sidebar**: Slide navigation (click to switch), resizable width (drag handle), finalize button at bottom
- **Tile grid**: 2-column layout. `"half"` tiles share a row, `"full"` tiles span both columns. Each tile has a type badge, optional title, content renderer, resize handle, and collapsible comments section.
- **Chat panel**: General conversation between user and agent. Resizable width.
- **Theme**: Dark (default) and light mode, toggled via button in sidebar header. Persisted in localStorage.

### Tile rendering

| Type | Renderer |
|------|----------|
| markdown | Client-side via marked.js |
| mermaid | Client-side via mermaid.js (with zoom/pan) |
| kroki | Server-side via kroki.io API (with zoom/pan) |
| html | Raw innerHTML |
| svg | Raw innerHTML (with zoom/pan) |

Diagrams (mermaid, kroki, svg) get a viewport with scroll-to-zoom and drag-to-pan.

### Comment system

Each tile has a comments section with a "Comments (N)" toggle bar. Comments default to visible. Users can:
- Add a comment (textarea + Ctrl+Enter)
- Apply a comment (triggers `comment-applied` inbox event for the agent)
- Remove a comment

When the agent processes a `comment-applied` event, it updates the tile content via `PUT /api/slides/:slideId/tiles/:tileId` and acknowledges in chat.

## Two-phase workflow

### Phase 1: Prepare (`/workshop-prepare`)

The agent gathers context (Read/Grep/Glob), structures findings into slides, and writes a `.workshop.yaml` file to `docs/workshops/`. No server, no browser — pure file output.

### Phase 2: Present (`/workshop-start`)

The agent starts the server, loads the YAML, opens the browser, and enters an interactive polling loop:

```
1. Start server (bun run server.ts)
2. Load workshop YAML (POST /api/workshop/load)
3. Open browser (open http://127.0.0.1:7892)
4. Interactive loop:
   - Poll GET /api/inbox?unconsumed=true
   - Handle events (reply to chats, update tiles from applied comments)
   - Mark events consumed
   - Sleep 3 seconds, repeat
5. On finalize-requested: write summary markdown, report, exit
```

## Output artifacts

After finalization, two files are written to `docs/workshops/`:

| File | Content |
|------|---------|
| `YYYY-MM-DD-<slug>.workshop.yaml` | Full workshop state (slides, tiles, comments, chat) |
| `YYYY-MM-DD-<slug>.summary.md` | Agent-curated summary suitable as LLM context for downstream planning |

## Extension points

When adding features, keep these patterns in mind:

- **New tile type**: Add to `TileType` union in `types.ts`, add renderer in the UI's `renderTileContent()` function, add any server-side processing if needed.
- **New inbox event**: Add to `InboxEventType` union in `types.ts`, create events with `addInboxEvent()` in server, handle in the `/workshop-start` skill's polling loop.
- **New API endpoint**: Add route handler in the `Bun.serve` fetch function in server.ts. Follow the existing pattern: parse URL, handle method, return `jsonResponse()`, call `broadcastState()` if state changed.
- **UI changes**: All CSS and HTML are inline in `server.ts` within the `PAGE_HTML` template string. CSS variables are defined on `:root` (dark) and `:root.light` (light theme).

## Design decisions

| Decision | Rationale |
|----------|-----------|
| Single-file server | Follows claude-viz pattern. Easy to deploy, no build step. |
| No external YAML dependency | Custom serializer keeps server self-contained. |
| curl over MCP | Agent communicates via `Bash(curl *)` which is auto-approved in skill `allowed-tools`. Simpler than MCP for V1. |
| General chat (not per-slide) | Avoids fragmenting the conversation. One continuous thread. |
| Append-first comments | Comments are always appended as `pending`. User promotes to `applied` or `removed`. Applied triggers agent action. |
| Mark-as-consumed inbox | Events are never deleted, only consumed. Full audit trail. |
| SSE for live updates | Server pushes full state on every change. Client replaces its state and re-renders. |
