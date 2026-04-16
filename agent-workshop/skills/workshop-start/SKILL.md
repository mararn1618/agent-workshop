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

## Step 1: Start the Server

Check if the server is already running:

```bash
curl -s http://127.0.0.1:7892/api/health
```

If this returns `{"status":"ok",...}`, the server is running. Skip to opening the browser.

If not running, start it:

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

Verify the load succeeded (response has `"ok": true`). Then fetch the workshop state to confirm slides are populated:

```bash
curl -s http://127.0.0.1:7892/api/workshop
```

Tell the user how many slides were loaded and give a one-line description of the workshop topic.

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

Then enter the polling loop:

```
LOOP (repeat until finalize event is received):

  1. Poll the inbox for unconsumed events:
     curl -s "http://127.0.0.1:7892/api/inbox?unconsumed=true"

  2. For each unconsumed event, handle by type:

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
     - Read the payload: { path, slug }
     - EXIT the loop — proceed to Step 5

  3. Mark each processed event as consumed:
     curl -s -X POST "http://127.0.0.1:7892/api/inbox/<eventId>/consume"

  4. Sleep briefly before the next poll:
     sleep 3
```

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

1. Read the exported YAML file from the path in the event payload.
2. Read the full workshop state:
   ```bash
   curl -s http://127.0.0.1:7892/api/workshop
   ```
3. Read the chat history:
   ```bash
   curl -s http://127.0.0.1:7892/api/chat
   ```
4. Write a curated summary to `docs/workshops/YYYY-MM-DD-<slug>.summary.md`:
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

Tell the user:

- Workshop finalized.
- YAML state saved to: `docs/workshops/<file>.workshop.yaml`
- Summary written to: `docs/workshops/<file>.summary.md`
- Suggest next step: "Ready for `/discuss-plan-implement:create-plan` when you are."

## Stopping the Server

If the user asks to stop the workshop server:

```bash
kill $(lsof -ti:7892) 2>/dev/null
```

## Full API Reference

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | /api/health | -- | Health check: returns status, slide count, chat count |
| GET | /api/workshop | -- | Get full workshop state (slides, chat, status) |
| POST | /api/workshop/load | `{path: string}` | Load workshop from a YAML file on disk |
| POST | /api/slides | `{title, order, tiles[]}` | Push a new slide |
| PUT | /api/slides/:id | `{title?, order?, tiles?}` | Update an existing slide |
| DELETE | /api/slides/:id | -- | Remove a slide |
| POST | /api/slides/:slideId/tiles | `{type, content, size, title?, krokiDiagramType?}` | Add a tile to a slide |
| PUT | /api/slides/:slideId/tiles/:tileId | `{type?, content?, title?, size?, krokiDiagramType?}` | Update a tile |
| POST | /api/chat | `{author: "agent", content: "..."}` | Post a chat message |
| GET | /api/chat | -- | Get chat history |
| POST | /api/tiles/:tileId/comments | `{author, content}` | Add a comment to a tile |
| PUT | /api/tiles/:tileId/comments/:commentId | `{status?, content?}` | Update a comment (set status to "applied") |
| GET | /api/inbox | `?unconsumed=true` | Poll inbox for events |
| POST | /api/inbox/:id/consume | -- | Mark an inbox event as consumed |
| POST | /api/finalize | `{output_dir?, slug?}` | Finalize: writes YAML to disk, creates finalize-requested event |

### Inbox event types

| Type | Payload | Trigger |
|------|---------|---------|
| `chat-message` | `{messageId, content}` | User posts a chat message |
| `comment-applied` | `{tileId, commentId, content}` | User applies a comment on a tile |
| `finalize-requested` | `{path, slug}` | Finalize endpoint is called |

### Tile types

| Type | Fields | Notes |
|------|--------|-------|
| `markdown` | content (markdown string) | Standard slide content |
| `mermaid` | content (mermaid syntax) | Client-side rendered |
| `kroki` | content, krokiDiagramType, krokiOutputFormat? | Server-rendered via Kroki |
| `html` | content (raw HTML) | Full control over rendering |
| `svg` | content (SVG string) | Inline SVG |
