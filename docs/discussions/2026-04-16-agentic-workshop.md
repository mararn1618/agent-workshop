---
story: "Build Agentic Workshop — a browser-based, slide-driven alignment tool where the agent prepares a structured workshop asynchronously and then guides the user through it interactively"
created: 2026-04-16
---

# Discussion: Agentic Workshop

## Intent
Replace the synchronous CLI `/discuss` flow (and the failed async GitHub Issue approach) with a hybrid async-prep + sync-presentation model for the alignment phase of development. An agent prepares a visual, slide-based workshop, then guides the user through it in a browser UI with per-tile comments and a live chat panel. The tool extends the existing `claude-viz` skill's architecture (Bun server, sidebar+cards UI, SSE, curl-based agent API).

## Acceptance Criteria
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

## Key Decisions
- **Extend claude-viz, don't rewrite.** The existing Bun server, sidebar+cards UI, SSE broadcast, and REST API are the foundation. New work is the bidirectional communication layer and workshop lifecycle on top.
- **curl over MCP for V1.** Keeps everything self-contained in one skill package. The skill's `allowed-tools: Bash(curl *)` auto-approves server calls. MCP can be added later if the number of operations grows unwieldy.
- **General chat, not per-slide.** Simplifies state model and UI. One chat panel for the whole workshop.
- **Comments are the core interactive primitive on tiles.** Every tile can be commented on. Question-tiles are just tiles the agent creates with the intent of being commented — no special type or UI needed beyond the standard comment system.
- **Comment lifecycle: append-first.** Comments default to "pending" (visible but not acted on). User explicitly promotes to "applied" (which notifies the agent) or "removed." Agent never auto-acts on a comment.
- **Inbox is mark-as-consumed, never delete.** Full event history stays in server state for future export/import.
- **Two-phase workflow: prepare and present are separable.** `/workshop-prepare` writes the YAML file. `/workshop-start` loads and presents it. The YAML file is the handoff artifact between phases. User can prepare now and present later.
- **Server writes full state to disk on finalize.** Avoids token waste — the server has the complete typed state. Agent then reads the file to produce the curated summary.
- **TypeScript types are the single source of truth for the data model.** Server imports them directly. Skill markdown references them. No separate YAML schema document needed.
- **Self-contained skill.** No dependency on `discuss-plan-implement` or any other skill. If someone wants to chain workshop output into `/create-plan`, that's a workflow choice, not a coupling.
- **Summary strips visual noise.** The agent-curated summary replaces diagram/SVG content with placeholders so the summary is suitable as LLM context for downstream planning.

## Constraints
- Local only — no cloud services, no external dependencies beyond Bun and Kroki (already used by claude-viz)
- Single user — no multi-user collaboration
- The workshop state YAML must be serializable and round-trippable (prepare -> present -> finalize -> future import must not lose data)
- The TypeScript type definitions must be usable by both the server (imports) and the skill (referenced in markdown)
- Workshop state is in-memory during a session; no server-side persistence beyond the finalize-to-disk step

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

## Open Questions
- Exact slide navigation behavior when agent updates a slide — auto-navigate to it, or just highlight in sidebar? (Can be decided during implementation)
- Whether user can reorder slides or only navigate the agent's ordering (lean toward agent-ordered for V1)
- Notification mechanism when `/workshop-prepare` finishes and the workshop is ready (Channels, ntfy, or just terminal output for V1)
- Whether the chat panel should be movable to the left side (stacked with sidebar) in addition to the right side (defer to V1.5)
