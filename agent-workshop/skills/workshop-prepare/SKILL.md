---
description: "Prepare an Agent Workshop — gather context, structure findings into slides with tiles, and write a .workshop.yaml file. Use this when you need to prepare a visual, structured alignment workshop for a task or feature."
context: fork
allowed-tools: Bash(curl *), Read, Grep, Glob
---

# Workshop Prepare — Gather Context, Structure Slides, Write YAML

## Your Task

Prepare an alignment workshop for: $ARGUMENTS

Analyze the relevant code, architecture, or context described above. Gather information, identify key decisions and open questions, structure everything into slides with tiles, and write a `.workshop.yaml` file.

If no specific topic is given, explore the project structure and create a general architecture alignment workshop.

## How It Works

1. You gather context about the task using Read/Grep/Glob
2. You organize findings into slides, each covering one thought unit
3. You serialize the workshop as YAML matching the data model
4. You write the YAML file to `docs/workshops/`
5. The user later runs `/workshop-start` to launch the interactive browser session

This skill does NOT start a server, open a browser, or modify any project code. It only produces the YAML file.

## Step 1: Gather Context

Use Read, Grep, and Glob to understand the task and its surrounding context:

- Read relevant source files, configs, and documentation
- Search for related code patterns, dependencies, and architecture
- Look at git history if it helps understand recent changes
- If `$ARGUMENTS` contains a URL, use `curl` to fetch its content
- If `$ARGUMENTS` references files, read them directly

Build a mental model of: what exists today, what the task requires, where the gaps are, and what decisions need alignment.

## Step 2: Structure into Slides

Organize your findings into slides. Each slide covers **one thought unit** — a single topic, decision, or question area.

**Scale the number of slides to the complexity of the task.** A small bug fix might need 3 slides. A major architecture decision might need 8-12.

### Slide composition guidelines

Each slide has a title and one or more tiles. Mix tile types to make slides informative and visually varied:

- **Markdown tiles**: text explanations, summaries, decision rationale, lists, tables
- **Mermaid tiles**: simple diagrams (flowcharts, sequence diagrams with 3 or fewer participants)
- **Kroki tiles**: complex diagrams (PlantUML, GraphViz, C4, D2, DBML) — always include the `krokiDiagramType` field
- **HTML tiles**: custom layouts, stats grids, metrics dashboards
- **SVG tiles**: raw SVG content

### Tile sizing

- `"full"`: wide/landscape diagrams, wide tables (4+ columns), large HTML dashboards
- `"half"`: text explanations, small diagrams, side-by-side cards, stats panels

Two `"half"` tiles on the same slide create a side-by-side layout.

### Questions and alignment points

Workshops exist to drive alignment. Scatter questions and decision points across slides where they are contextually relevant — do NOT front-load all questions onto a single slide.

Frame questions as markdown tiles with clear prompts the user can comment on. For example:

```markdown
## Decision needed

Should we use a push-based or pull-based sync model?

- **Push**: Lower latency, but requires webhook infrastructure
- **Pull**: Simpler, but introduces polling delay

What's your preference?
```

### What to look for

Hunt for gaps, contradictions, and unstated assumptions:

- Ambiguous requirements that need clarification
- Architecture decisions with multiple viable paths
- Implicit assumptions that should be made explicit
- Dependencies or risks that aren't obvious from the task description
- Trade-offs that the user should weigh in on

Include at least one architectural or structural diagram if the task involves code changes.

## Step 3: Generate the YAML

Serialize the workshop as YAML matching the TypeScript data model. The schema is defined in `types.ts`:

### Workshop structure

```yaml
id: "<6-char random alphanumeric>"
title: "Workshop Title"
description: "One-line description of what this workshop aligns on"
status: "ready"
created: "<ISO 8601 timestamp>"
slides:
  - id: "s1"
    title: "Slide Title"
    order: 0
    tiles:
      - id: "t1"
        type: "markdown"
        content: "## Heading\n\nBody text here..."
        size: "full"
        comments: []
      - id: "t2"
        type: "mermaid"
        content: "graph TD\n  A[Client] --> B[API]\n  B --> C[Database]"
        size: "half"
        comments: []
  - id: "s2"
    title: "Architecture"
    order: 1
    tiles:
      - id: "t3"
        type: "kroki"
        content: "@startuml\nactor User\nparticipant App\nUser -> App: Request\nApp --> User: Response\n@enduml"
        krokiDiagramType: "plantuml"
        size: "full"
        comments: []
      - id: "t4"
        type: "markdown"
        content: "## Decision needed\n\nShould we use approach A or B?\n\n- **A**: Pros and cons...\n- **B**: Pros and cons..."
        size: "half"
        comments: []
chat: []
```

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | 6-char random alphanumeric workshop ID |
| `title` | string | yes | Workshop title |
| `description` | string | no | One-line description |
| `status` | string | yes | Always `"ready"` when preparation is complete |
| `created` | string | yes | ISO 8601 timestamp |
| `slides` | array | yes | Ordered array of slides |
| `chat` | array | yes | Empty array `[]` — populated during the interactive session |

### Slide fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique slide ID (e.g., `"s1"`, `"s2"`) |
| `title` | string | yes | Slide title shown in navigation |
| `order` | number | yes | Zero-based display order |
| `tiles` | array | yes | Array of tile objects |

### Tile fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique tile ID (e.g., `"t1"`, `"t2"`) |
| `type` | string | yes | `"markdown"`, `"mermaid"`, `"kroki"`, `"html"`, `"svg"` |
| `title` | string | no | Optional tile header label |
| `content` | string | yes | Tile content (markdown, diagram source, HTML, SVG) |
| `size` | string | yes | `"full"` or `"half"` |
| `comments` | array | yes | Empty array `[]` — populated during the interactive session |
| `krokiDiagramType` | string | if type=kroki | `"plantuml"`, `"graphviz"`, `"c4plantuml"`, `"d2"`, `"dbml"`, etc. |
| `krokiOutputFormat` | string | no | `"svg"` (default) or `"png"` |

### Comment fields (for reference — not populated during preparation)

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique comment ID |
| `author` | string | `"user"` or `"agent"` |
| `content` | string | Comment text |
| `status` | string | `"pending"`, `"applied"`, or `"removed"` |
| `createdAt` | string | ISO 8601 timestamp |
| `appliedAt` | string | Optional — when the comment was applied |

## Step 4: Write the File

Resolve the project root and write the YAML to:

```
<project-root>/docs/workshops/YYYY-MM-DD_HH-MM_<slug>.workshop.yaml
```

The filename includes the current local time in `HH-MM` form so that multiple prepares on the same day don't collide. Example: `2026-04-18_17-08_auth-migration.workshop.yaml`.

Where `<slug>` is a short kebab-case name derived from the workshop title (e.g., `auth-migration`, `api-redesign`, `feature-x-alignment`).

Create the output directory if it does not exist:

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
mkdir -p "$PROJECT_ROOT/docs/workshops"
```

Write the file to `$PROJECT_ROOT/docs/workshops/YYYY-MM-DD_HH-MM_<slug>.workshop.yaml`.

## Step 5: Report and Hand Off

After writing the file, report back:

- The file path of the generated workshop YAML
- The number of slides and total tile count
- A one-sentence summary of what the workshop covers

Then suggest: "Run `/workshop-start` to launch the interactive workshop session."

## Diagram Type Guide

**Prefer Kroki** for richer, better-looking diagrams. Use Mermaid only for quick simple cases.

| Need | Best Choice | Type | Alternative |
|---|---|---|---|
| Architecture (C4 model) | C4 PlantUML | `kroki` + `c4plantuml` | `kroki` + `structurizr` |
| Architecture (informal) | D2 | `kroki` + `d2` | `kroki` + `graphviz` |
| Database schema / ER | DBML | `kroki` + `dbml` | Mermaid `erDiagram` |
| Sequence diagram | PlantUML | `kroki` + `plantuml` | Mermaid `sequenceDiagram` |
| Flowchart | D2 or GraphViz | `kroki` + `d2` / `graphviz` | Mermaid `flowchart` |
| Class diagram | PlantUML | `kroki` + `plantuml` | Mermaid `classDiagram` |
| Dependency / call graph | GraphViz DOT | `kroki` + `graphviz` | -- |
| State machine | PlantUML | `kroki` + `plantuml` | Mermaid `stateDiagram-v2` |

## Important: Diagram Theming

**Kroki diagrams render on a LIGHT background.** Do NOT add dark-theme skinparam overrides. Use default PlantUML colors. For GraphViz, use light fill colors (`fillcolor=lightyellow`, `fillcolor=lightblue`).

**Mermaid diagrams render on a DARK background.** When setting custom `fill` via `style` directives, always include an explicit text `color`:
- Light fill → `color:#000`
- Dark fill → `color:#fff`

**Mermaid line breaks:** Use `<br/>`, not `\n`.

## Important: YAML Content Escaping

When writing multi-line content in YAML string fields, use YAML block scalars or properly escape special characters. For diagram content, prefer the YAML literal block scalar (`|`) to preserve newlines:

```yaml
content: |
  graph TD
    A[Client] --> B[API]
    B --> C[Database]
```

For inline markdown with special characters, use quoted strings with `\n` for newlines:

```yaml
content: "## Heading\n\nParagraph text with **bold** and *italic*."
```
