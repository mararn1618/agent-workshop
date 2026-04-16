# Agentic Workshop

A self-contained Claude Code plugin for browser-based, slide-driven alignment workshops between humans and AI agents.

The agent prepares a structured workshop asynchronously (reading your codebase, structuring findings into slides with diagrams and questions), then presents it interactively in the browser. You walk through slides together, chat, comment on tiles, and refine in real time until you reach alignment.

## Why

Complex tasks need alignment before implementation. Text-only conversations lose structure, and walls of questions are overwhelming. Agentic Workshop solves this with a two-phase approach:

1. **Prepare** (async) — the agent reads code, gathers context, and builds a slide deck with diagrams, decision points, and questions
2. **Present** (interactive) — you and the agent walk through slides in the browser, chatting and refining until aligned

Slide-based format enforces one topic per screen. Comments on tiles let you give precise, contextual feedback. The agent responds live.

## Install

Requires [Bun](https://bun.sh):

```bash
curl -fsSL https://bun.sh/install | bash
```

Copy or symlink this directory into your Claude Code plugins folder:

```bash
ln -s /path/to/agentic-workshop ~/.claude/plugins/agentic-workshop
```

## Usage

### 1. Prepare a workshop

```
/workshop-prepare <topic, task description, or file references>
```

The agent gathers context from your codebase, structures findings into slides with diagrams and questions, and writes a `.workshop.yaml` file to `docs/workshops/`.

### 2. Start the interactive session

```
/workshop-start
```

This starts the server on `http://127.0.0.1:7892`, loads the workshop, and opens your browser. The agent enters a live loop:

- **Chat** in the right panel — ask questions, give direction
- **Comment** on any tile — precise, contextual feedback
- **Apply** a comment — the agent updates that tile in real time
- **Navigate** slides in the sidebar
- **Finalize** when done — writes YAML state + curated summary to `docs/workshops/`

## Tile types

| Type | Use for |
|------|---------|
| Markdown | Text, tables, decision prompts |
| Mermaid | Simple flowcharts, sequence diagrams |
| Kroki | Rich diagrams (PlantUML, GraphViz, C4, D2, DBML) |
| HTML | Custom layouts, dashboards |
| SVG | Inline vector graphics |

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `WORKSHOP_PORT` | 7892 | Server port |
| `WORKSHOP_HOST` | 127.0.0.1 | Server host |

## Project structure

```
.claude-plugin/plugin.json    Plugin metadata
server.ts                     Bun server (REST API + embedded UI)
types.ts                      TypeScript type definitions
skills/workshop-prepare/      Prepare skill (async context gathering)
skills/workshop-start/        Start skill (interactive presentation loop)
docs/ARCHITECTURE.md          Full architecture reference for developers
docs/workshops/               Workshop output files (YAML + summaries)
```

## License

See [LICENSE](LICENSE).
