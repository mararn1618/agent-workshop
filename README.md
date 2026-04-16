# Agentic Workshop

A Claude Code plugin for browser-based, slide-driven alignment workshops. The agent prepares a structured workshop asynchronously, then presents it interactively in the browser — you chat, comment on tiles, and refine together in real time.

## Why

The standard `/discuss` flow works for small tasks but struggles with complex topics: no visuals, no diagrams, hard to track multiple threads. Async alternatives (GitHub issue comments) dump too many questions at once. Agentic Workshop separates **preparation** (slow, async — the agent reads code and structures findings) from **presentation** (fast, interactive — you walk through slides together).

## Install

Copy or symlink this directory into your Claude Code plugins folder:

```bash
# Option A: Symlink
ln -s /path/to/agentic-workshop ~/.claude/plugins/agentic-workshop

# Option B: Copy
cp -r /path/to/agentic-workshop ~/.claude/plugins/agentic-workshop
```

The plugin requires [Bun](https://bun.sh) to run the server:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Usage

### 1. Prepare a workshop

```
/workshop-prepare <topic or context>
```

The agent gathers context from your codebase, structures findings into slides with diagrams and questions, and writes a `.workshop.yaml` file to `docs/workshops/`.

### 2. Start the interactive session

```
/workshop-start
```

This starts the server on `http://127.0.0.1:7892`, loads the workshop, and opens your browser. The agent enters a live polling loop — you can:

- **Chat** with the agent in the right panel
- **Comment** on any tile (add, apply, remove)
- **Apply** a comment to trigger the agent to update that tile
- **Navigate** slides in the sidebar

When you're done, click **Finalize Workshop** in the sidebar. The agent writes the final YAML and a curated summary to `docs/workshops/`.

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
