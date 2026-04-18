---
description: "Start an Agent Workshop — load a prepared workshop, open the browser UI, and enter the interactive moderation loop. Use this after /workshop-prepare has created a .workshop.yaml file, or provide context and this skill will prepare first."
context: fork
allowed-tools: Bash(curl *), Bash(bun *), Bash(open *), Bash(kill *), Bash(lsof *), Read, Grep, Glob
---

# Workshop Start — Run an Interactive Workshop

## Your Task

Start and moderate the workshop: $ARGUMENTS

## Step 0: Find or Prepare the Workshop

Locate the `.workshop.yaml` file to load:

1. If `$ARGUMENTS` references an existing `.workshop.yaml` file path, use that.
2. Otherwise, search `docs/workshops/` in the current project for the most recent `.workshop.yaml`:
   ```bash
   ls -t docs/workshops/*.workshop.yaml 2>/dev/null | head -1
   ```
3. If no workshop file exists, tell the user: "No prepared workshop found. Run `/workshop-prepare` first to create one, or provide context and I can prepare inline."
   - Stop here unless the user provides enough context to prepare on the fly.

Store the absolute path in `WORKSHOP_FILE` for later steps.

## Step 1: Start the Server (or reconnect to a running one)

Check if the server is already running AND whether a workshop is already loaded:

```bash
curl -s http://127.0.0.1:7892/api/health
```

Interpret the response:

- **No response / connection refused** → server is not running. Start it (see below).
- **`slides: 0`** → server is running but empty. Proceed to Step 2 to load the YAML.
- **`slides > 0` and `currentSourcePath` matches `$WORKSHOP_FILE`** → the server already has the target workshop loaded. This is a reconnect (e.g. after context compaction). **Skip Step 2 entirely** and jump to the browser + Step 4 polling. Brief the user: "Reconnecting to active workshop with N slides."
- **`slides > 0` and `currentSourcePath` points to a *different* file** → a different workshop is live. Tell the user and ASK which to do: reconnect to the currently-loaded workshop, or load the new one (which will prompt the user to confirm in the browser via Step 2).

Note: resume-vs-fresh is no longer an agent decision. If the load response includes `pendingResume: true`, tell the user to pick **Resume** or **Start Fresh** in the browser modal that has appeared, then wait for a follow-up poll result or SSE event indicating the load succeeded before continuing.

If the server is not running, start it:

```bash
bun run SKILL_BASE_DIR/../../server.ts &
```

Wait and verify:

```bash
sleep 1 && curl -s http://127.0.0.1:7892/api/health
```

Open the browser:

```bash
open http://127.0.0.1:7892
```

After the server is confirmed running, slides are loaded, and the browser is opened, announce the workshop with an ASCII banner. This makes the URL clickable and gives a clear visual signal that the workshop is ready:

```
  ╔══════════════════════════════════════════════════════════╗
  ║                                                          ║
  ║   ⬡  A G E N T I C   W O R K S H O P                   ║
  ║                                                          ║
  ║   Workshop ready: <N> slides loaded                      ║
  ║                                                          ║
  ║   → http://127.0.0.1:7892                                ║
  ║                                                          ║
  ║   Place the browser next to your terminal.               ║
  ║   Chat, comment on tiles, or finalize when done.         ║
  ║                                                          ║
  ╚══════════════════════════════════════════════════════════╝
```

Replace `<N>` with the actual slide count. Output this directly as text (not via echo/bash) so it renders cleanly in the terminal.

## Step 2: Load the Workshop

Load the prepared YAML file into the server:

```bash
curl -s -X POST http://127.0.0.1:7892/api/workshop/load \
  -H "Content-Type: application/json" \
  -d '{"path": "'"$WORKSHOP_FILE"'"}'
```

Interpret the response:

- **`{"ok": true, ...}`** → load accepted. Standard flow — proceed to confirm slides are populated.
- **`{"ok": true, "pendingResume": true, ...}`** → the server found a live sidecar for this workshop and is waiting for the user to choose. Tell the user: "A browser modal has appeared — pick **Resume** to restore your prior session or **Start Fresh** to begin clean." Then wait: poll `/api/health` until `pendingResume` is absent or false, then confirm the load via `GET /api/workshop`. Do NOT re-issue the load call.
- **HTTP 409 with `{"ok": false, "pending": true, "summary": {...}}`** → a *different* workshop is already loaded. The server has now emitted a pending-load event; the browser will show a modal asking the user to accept (discard current, load new) or decline (keep current). **Wait for the user to decide via the browser** — poll `/api/health` until `hasPendingLoad` is false, then check `/api/workshop` to see which workshop is loaded. Do NOT retry the load call.
- **Other errors** → report the error and stop.

Then fetch the workshop state to confirm slides are populated:

```bash
curl -s http://127.0.0.1:7892/api/workshop
```

Tell the user how many slides were loaded and give a one-line description of the workshop topic.

### State persistence

The server writes a `<workshop>.workshop.live.yaml` sidecar file next to the source YAML on every mutation (debounced). This captures comments, chat messages, tile updates, and unconsumed inbox events. If the conversation is compacted and this skill restarts, the next `/api/workshop/load` call on the same source path will automatically restore the live state — the agent does not need to do anything special. On `/api/finalize`, the sidecar is deleted and the finalized YAML in `docs/workshops/` becomes the source of truth.

## Step 3: Push Slides (if needed)

If loading from YAML populated the slides, skip this step.

If building on-the-fly or the YAML had no slides, push slides one at a time:

```bash
curl -s -X POST http://127.0.0.1:7892/api/slides \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Slide Title",
    "order": 0,
    "tiles": [
      {
        "type": "markdown",
        "content": "## Heading\n\nSlide content here.",
        "size": "full"
      }
    ]
  }'
```

Tile types: `"markdown"`, `"mermaid"`, `"kroki"`, `"html"`, `"svg"`. Each tile has a `size` of `"full"` or `"half"`. Kroki tiles need `"krokiDiagramType"` (e.g. `"plantuml"`, `"graphviz"`, `"d2"`).

## Step 4: Enter the Interactive Loop

This is the core of the workshop. You poll the inbox for user interactions and respond to each one.

Send an opening chat message to greet the user:

```bash
curl -s -X POST http://127.0.0.1:7892/api/chat \
  -H "Content-Type: application/json" \
  -d '{"author": "agent", "content": "Workshop is live! Take a look through the slides and let me know your thoughts. You can chat here or add comments directly on any tile."}'
```

Then enter the polling loop. Use the **long-poll endpoint** — it blocks on the server until an event arrives (or up to ~30s timeout), so you do not need to sleep between polls. The loop is server-paced.

```
LOOP (repeat until finalize event is received):

  1. Long-poll for unconsumed events (blocks up to 30s):
     curl -s --max-time 40 "http://127.0.0.1:7892/api/inbox/wait?timeout=30"

     Returns:
     - `[]` — timeout reached with no events. Immediately call it again.
     - `[{...}, ...]` — one or more unconsumed events. Process them.

  2. For each returned event, handle by type:

     --- type: "chat-message" ---
     The user sent a chat message.
     - Read the payload: { messageId, content }
     - Think about the user's message in the context of the workshop
     - Reply via POST /api/chat with author "agent"
     - Be thoughtful and substantive — not just "acknowledged"
     - If the user's message suggests a change, update the relevant slide/tile

     --- type: "comment-applied" ---
     The user applied a comment on a tile.
     - Read the payload: { tileId, commentId, content }
     - Find the slide and tile this comment belongs to (GET /api/workshop)
     - Update the tile content to incorporate the feedback:
       curl -s -X PUT "http://127.0.0.1:7892/api/slides/<slideId>/tiles/<tileId>" \
         -H "Content-Type: application/json" \
         -d '{"content": "...updated content..."}'
     - Acknowledge in chat: "Updated tile X based on your feedback: <summary of change>"
     - Direct the user's attention: "Take a look at slide N — I have updated it."

     --- type: "finalize-requested" ---
     The user clicked finalize in the UI or the finalize endpoint was called.
     - Read the payload: { finalizedPath, summaryPath, sourcePath, slug, timestamp }
     - EXIT the loop — proceed to Step 5

  3. Mark each processed event as consumed:
     curl -s -X POST "http://127.0.0.1:7892/api/inbox/<eventId>/consume"

  4. Return to step 1 — do NOT sleep. The server will block the next call itself.
```

### Why long-polling (and what to do if it breaks)

Each long-poll call blocks on the server for up to ~30 seconds. This keeps latency near-zero for user interactions while consuming minimal context (no repeated polls, no sleep calls). One bash call = up to 30 seconds of idle time.

If your polling loop is interrupted — for example by a context compaction, a crash, or the bash command timing out — do NOT worry about in-flight state. Everything is persisted in `<workshop>.workshop.live.yaml`. The user can simply re-invoke `/workshop-start` and Step 1's reconnect logic will detect the running server, skip the load, and you will resume polling right where you left off.

### Tone and personality

You are a **warm, professional colleague** moderating a workshop — not a robotic assistant. Think of yourself as a senior engineer who prepared a presentation and is now walking a teammate through it.

- **Be conversational and warm.** Use natural language, not formal report-speak. "Good catch — I hadn't considered that angle" is better than "Acknowledged. Updating the tile."
- **Occasional light humor is welcome** — but don't force it. A brief aside or a well-placed "well, that's one way to break it" is fine. Don't make it a comedy show.
- **Be responsive**: when a user chats, reply thoughtfully. Engage with the substance of their input.
- **Show genuine engagement.** If the user makes a good point, say so. If they catch something you missed, own it.
- **Scale depth to complexity**: short questions get short answers; detailed feedback gets detailed revisions.

### Interactive behavior guidance

- **When a comment is applied**: update the tile AND acknowledge in chat. Example: "Good point — I've updated the architecture diagram on slide 3 to reflect the cache layer change."
- **Proactive updates**: you can push new slides or update tiles during the loop if the conversation warrants it.
- **Direct attention**: after making changes, tell the user where to look. Example: "Take a look at slide 4 — I've restructured the data flow based on our discussion."

## Step 5: Finalization

When a `finalize-requested` event is received:

The event payload contains: `{ finalizedPath, summaryPath, sourcePath, slug, timestamp }`. Use these exact values — do not derive or generate your own file paths.

1. Read the exported YAML file from `finalizedPath` (absolute path from the event payload).
2. Read the full workshop state:
   ```bash
   curl -s http://127.0.0.1:7892/api/workshop
   ```
3. Read the chat history:
   ```bash
   curl -s http://127.0.0.1:7892/api/chat
   ```
4. Write a curated summary to the exact path given by `summaryPath` from the event payload:
   - Include the workshop title and description
   - Summarize each slide's content in 1-2 sentences
   - Replace diagram/SVG/HTML tile content with `[diagram: <title>]` placeholders
   - Include all applied comments as "User feedback: ..."
   - Include all chat messages as a conversation log section
   - Keep it concise and structured — suitable as LLM context for downstream planning

### Summary format

```markdown
# Workshop Summary: <title>

<description>

## Slides

### Slide 1: <title>
<1-2 sentence summary>
- User feedback: "<applied comment text>"

### Slide 2: <title>
[diagram: <tile title>]
<summary of what the diagram shows>

## Conversation Log

- **user**: <message>
- **agent**: <message>
...

## Key Decisions
- <bullet points distilled from the discussion>
```

## Step 6: Report and Exit

Output the following closing message (use the absolute paths from the event payload):

```
Workshop finalized.
- Summary (LLM-optimized, no diagrams): <summaryPath absolute>
- Full finalized state: <finalizedPath absolute>

Read the summary file now before proceeding with any follow-up work based on this workshop.
```

Then use the `Read` tool to read the summary file at `summaryPath` before doing anything else.

## Stopping the Server

After finalization, the server shuts itself down automatically after a 30-second grace period — no manual action needed.

If you need to abandon a non-finalized workshop (before finalize has been called), kill the server manually:

```bash
kill $(lsof -ti:7892) 2>/dev/null
```

## Full API Reference

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | /api/health | -- | Health check: returns status, slide count, chat count; includes `pendingResume` flag when relevant |
| GET | /api/workshops | -- | List all known workshops (slug, path, timestamps) |
| GET | /api/workshop | -- | Get full workshop state (slides, chat, status) |
| POST | /api/workshop/load | `{path: string}` | Load workshop from a YAML file; returns `pendingResume: true` if a live sidecar exists |
| POST | /api/workshop/load/resume | -- | Confirm resume: restore sidecar state for the pending load |
| POST | /api/workshop/load/fresh | -- | Confirm fresh start: discard sidecar and load clean from source YAML |
| POST | /api/slides | `{title, order, tiles[]}` | Push a new slide |
| PUT | /api/slides/:id | `{title?, order?, tiles?}` | Update an existing slide |
| DELETE | /api/slides/:id | -- | Remove a slide |
| POST | /api/slides/:slideId/tiles | `{type, content, size, title?, krokiDiagramType?}` | Add a tile to a slide |
| PUT | /api/slides/:slideId/tiles/:tileId | `{type?, content?, title?, size?, krokiDiagramType?}` | Update a tile |
| POST | /api/chat | `{author: "agent", content: "..."}` | Post a chat message |
| GET | /api/chat | -- | Get chat history |
| POST | /api/tiles/:tileId/comments | `{author, content}` | Add a comment to a tile |
| PUT | /api/tiles/:tileId/comments/:commentId | `{status?, content?}` | Update a comment (set status to "applied") |
| GET | /api/inbox | `?unconsumed=true` | Poll inbox for events (returns immediately) |
| GET | /api/inbox/wait | `?timeout=30` | Long-poll: blocks up to N seconds until events arrive |
| POST | /api/inbox/:id/consume | -- | Mark an inbox event as consumed |
| POST | /api/finalize | `{output_dir?, slug?}` | Finalize: writes YAML to disk, shuts down server after 30s grace |

### Inbox event types

| Type | Payload | Trigger |
|------|---------|---------|
| `chat-message` | `{messageId, content}` | User posts a chat message |
| `comment-applied` | `{tileId, commentId, content}` | User applies a comment on a tile |
| `finalize-requested` | `{finalizedPath, summaryPath, sourcePath, slug, timestamp}` | Finalize endpoint is called |

### Tile types

| Type | Fields | Notes |
|------|--------|-------|
| `markdown` | content (markdown string) | Standard slide content |
| `mermaid` | content (mermaid syntax) | Client-side rendered |
| `kroki` | content, krokiDiagramType, krokiOutputFormat? | Server-rendered via Kroki |
| `html` | content (raw HTML) | Full control over rendering |
| `svg` | content (SVG string) | Inline SVG |
