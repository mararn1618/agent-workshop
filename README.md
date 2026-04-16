# Agentic Workshop

Browser-based workshop tool for human-AI alignment. The agent prepares slides from your codebase, then you walk through them together in the browser - chatting, commenting on tiles, and iterating until you're aligned.

Works with Claude Code, Copilot, Cursor, Windsurf, Codex, and anything else that can run shell commands.

## The idea

When you're about to build something complex, you need alignment first. But text-only back-and-forth in the terminal doesn't scale, and async approaches (like dumping 15 questions into a GitHub issue) are overwhelming.

This plugin splits the work into two phases:

1. **Prepare** - the agent reads your code, gathers context, and builds a slide deck with diagrams and questions. This happens async, takes a few minutes.
2. **Present** - you open the browser, walk through slides one by one, leave comments, chat. The agent responds live and updates tiles based on your feedback.

One topic per screen. Diagrams where they help. Questions where they're contextually relevant, not front-loaded.

## Prerequisites

You need [Bun](https://bun.sh) to run the workshop server:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Install

### Claude Code

```
/plugin marketplace add mararn1618/agent-workshop
/plugin install agentic-workshop@agent-workshop
```

This gives you `/workshop-prepare` and `/workshop-start` as skills.

### GitHub Copilot

```bash
curl -fsSL https://raw.githubusercontent.com/mararn1618/agent-workshop/main/install.sh | bash -s -- copilot
```

Then add to `.github/copilot-instructions.md`:

```
@.github/agentic-workshop/skills/workshop-prepare/SKILL.md
@.github/agentic-workshop/skills/workshop-start/SKILL.md
```

### Cursor

```bash
curl -fsSL https://raw.githubusercontent.com/mararn1618/agent-workshop/main/install.sh | bash -s -- cursor
```

### Windsurf

```bash
curl -fsSL https://raw.githubusercontent.com/mararn1618/agent-workshop/main/install.sh | bash -s -- windsurf
```

### Codex / OpenCode / Gemini CLI

```bash
curl -fsSL https://raw.githubusercontent.com/mararn1618/agent-workshop/main/install.sh | bash -s -- codex
```

Then add to `AGENTS.md`:

```
@agentic-workshop/skills/workshop-prepare/SKILL.md
@agentic-workshop/skills/workshop-start/SKILL.md
```

### Any other agent

The whole thing is a Bun server and two markdown skill files. If your agent can run `bun`, `curl`, and `open`, it can use this. Point your agent at the two SKILL.md files in `skills/` - they contain everything: API reference, YAML schema, the interactive loop protocol.

## Usage

### 1. Prepare

```
/workshop-prepare <topic or context>
```

The agent explores your codebase and writes a `.workshop.yaml` to `docs/workshops/`.

### 2. Present

```
/workshop-start
```

Opens `http://127.0.0.1:7892` in your browser. From there:

- Chat with the agent in the right panel
- Comment on any tile for contextual feedback
- Hit "Apply" on a comment to have the agent update that tile
- Click "Finalize" when done

Output goes to `docs/workshops/` - both the full YAML state and a curated summary.

## Tiles

Slides contain tiles. Each tile is one of:

| Type | What it renders |
|------|----------------|
| Markdown | Text, tables, decision prompts |
| Mermaid | Flowcharts, sequence diagrams |
| Kroki | PlantUML, GraphViz, C4, D2, DBML |
| HTML | Custom layouts |
| SVG | Vector graphics |

Two half-width tiles sit side by side. Full-width tiles span the whole slide.

## Config

| Env var | Default | What it does |
|---------|---------|--------------|
| `WORKSHOP_PORT` | 7892 | Server port |
| `WORKSHOP_HOST` | 127.0.0.1 | Server bind address |

## Structure

```
.claude-plugin/marketplace.json       Marketplace metadata for Claude Code
install.sh                            Installer for non-Claude-Code harnesses
agentic-workshop/                     The plugin
  .claude-plugin/plugin.json          Plugin metadata
  server.ts                           Bun server with embedded UI
  types.ts                            Data model (source of truth)
  skills/workshop-prepare/            Prepare skill
  skills/workshop-start/              Interactive presentation skill
  ARCHITECTURE.md                     Architecture docs for contributors
```

## License

See [LICENSE](LICENSE).
