#!/usr/bin/env bun
/**
 * Agent Workshop — Browser-based slide-driven alignment tool.
 * Single-file Bun server, embedded HTML/CSS/JS, following the claude-viz pattern.
 */

import type {
  Workshop,
  WorkshopStatus,
  Slide,
  Tile,
  TileType,
  Comment,
  CommentStatus,
  ChatMessage,
  InboxEvent,
  InboxEventType,
} from "./types";

const PORT = parseInt(process.env.WORKSHOP_PORT || "7892");
const HOST = process.env.WORKSHOP_HOST || "127.0.0.1";

// --- In-memory state ---

let workshop: Workshop = {
  id: generateId(),
  title: "Untitled Workshop",
  status: "preparing",
  created: new Date().toISOString(),
  slides: [],
  chat: [],
};

const inbox: InboxEvent[] = [];
const sseClients = new Set<ReadableStreamDefaultController>();

let currentSourcePath: string | null = null;

interface PendingLoad {
  sourcePath: string;
  parsedData: Record<string, unknown>;
  requestedAt: string;
}
let pendingLoad: PendingLoad | null = null;

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function broadcast(event: string, data: unknown) {
  const msg =
    event === "message"
      ? `data: ${JSON.stringify(data)}\n\n`
      : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const controller of sseClients) {
    try {
      controller.enqueue(msg);
    } catch {
      sseClients.delete(controller);
    }
  }
}

function pendingLoadSummary() {
  if (!pendingLoad) return null;
  const parsed = pendingLoad.parsedData;
  const commentCount = workshop.slides.reduce(
    (sum, s) => sum + s.tiles.reduce((ss, t) => ss + t.comments.length, 0),
    0,
  );
  return {
    requested: {
      id: parsed.id as string,
      title: (parsed.title as string) || "Untitled",
      slideCount: ((parsed.slides as unknown[]) || []).length,
    },
    current: {
      id: workshop.id,
      title: workshop.title,
      commentCount,
      chatCount: workshop.chat.length,
      slideCount: workshop.slides.length,
    },
    requestedAt: pendingLoad.requestedAt,
  };
}

function broadcastState() {
  broadcast("workshop-update", { workshop, inbox, pendingLoad: pendingLoadSummary() });
  schedulePersist();
}

function addInboxEvent(type: InboxEventType, payload: Record<string, unknown>): InboxEvent {
  const evt: InboxEvent = {
    id: generateId(),
    type,
    payload,
    createdAt: new Date().toISOString(),
    consumed: false,
  };
  inbox.push(evt);
  return evt;
}

function livePathFor(sourcePath: string): string {
  const suffix = ".workshop.yaml";
  if (sourcePath.endsWith(suffix)) {
    return sourcePath.slice(0, -suffix.length) + ".workshop.live.yaml";
  }
  return sourcePath + ".live";
}

function schedulePersist() {
  if (!currentSourcePath) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistLive();
  }, 300);
}

async function persistLive() {
  if (!currentSourcePath) return;
  const livePath = livePathFor(currentSourcePath);
  try {
    await Bun.write(livePath, serializeLiveState());
  } catch (err) {
    console.error("persistLive failed:", err);
  }
}

function serializeLiveState(): string {
  return yamlSerialize({
    id: workshop.id,
    title: workshop.title,
    description: workshop.description,
    status: workshop.status,
    created: workshop.created,
    slides: workshop.slides.map((s) => ({
      id: s.id,
      title: s.title,
      order: s.order,
      tiles: s.tiles.map((t) => ({
        id: t.id,
        type: t.type,
        title: t.title,
        content: t.content,
        size: t.size,
        comments: t.comments.map((c) => ({
          id: c.id,
          author: c.author,
          content: c.content,
          status: c.status,
          createdAt: c.createdAt,
          appliedAt: c.appliedAt,
        })),
        krokiDiagramType: t.krokiDiagramType,
        krokiOutputFormat: t.krokiOutputFormat,
      })),
    })),
    chat: workshop.chat.map((m) => ({
      id: m.id,
      author: m.author,
      content: m.content,
      createdAt: m.createdAt,
    })),
    inbox: inbox.map((e) => ({
      id: e.id,
      type: e.type,
      payload: e.payload,
      createdAt: e.createdAt,
      consumed: e.consumed,
      consumedAt: e.consumedAt,
    })),
  });
}

function applyWorkshopFromParsed(parsed: Record<string, unknown>) {
  workshop.id = (parsed.id as string) || generateId();
  workshop.title = (parsed.title as string) || "Untitled Workshop";
  workshop.description = (parsed.description as string) || undefined;
  workshop.status = (parsed.status as WorkshopStatus) || "preparing";
  workshop.created = (parsed.created as string) || new Date().toISOString();
  workshop.slides = ((parsed.slides as unknown[]) || []).map((s: any, idx: number) => ({
    id: s.id || generateId(),
    title: s.title || `Slide ${idx + 1}`,
    order: s.order ?? idx + 1,
    tiles: ((s.tiles as unknown[]) || []).map((t: any) => ({
      id: t.id || generateId(),
      type: t.type || "markdown",
      title: t.title || undefined,
      content: t.content || "",
      size: t.size || "full",
      comments: ((t.comments as unknown[]) || []).map((c: any) => ({
        id: c.id || generateId(),
        author: c.author || "agent",
        content: c.content || "",
        status: c.status || "pending",
        createdAt: c.createdAt || new Date().toISOString(),
        appliedAt: c.appliedAt || undefined,
      })),
      krokiDiagramType: t.krokiDiagramType || undefined,
      krokiOutputFormat: t.krokiOutputFormat || undefined,
    })),
  }));
  workshop.chat = ((parsed.chat as unknown[]) || []).map((m: any) => ({
    id: m.id || generateId(),
    author: m.author || "agent",
    content: m.content || "",
    createdAt: m.createdAt || new Date().toISOString(),
  }));
  inbox.length = 0;
  const inboxData = parsed.inbox;
  if (Array.isArray(inboxData)) {
    for (const e of inboxData as any[]) {
      inbox.push({
        id: e.id || generateId(),
        type: (e.type as InboxEventType) || "chat-message",
        payload: (e.payload as Record<string, unknown>) || {},
        createdAt: e.createdAt || new Date().toISOString(),
        consumed: Boolean(e.consumed),
        consumedAt: e.consumedAt || undefined,
      });
    }
  }
}

// --- Simple YAML serializer/deserializer ---
// Handles the regular workshop structure without needing a full YAML library.

function yamlSerialize(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return pad + "null\n";
  if (typeof obj === "boolean") return pad + (obj ? "true" : "false") + "\n";
  if (typeof obj === "number") return pad + String(obj) + "\n";
  if (typeof obj === "string") {
    if (obj.includes("\n") || obj.includes('"') || obj.includes("'") || obj.includes(":") || obj.includes("#")) {
      return pad + "|\n" + obj.split("\n").map((line) => pad + "  " + line).join("\n") + "\n";
    }
    return pad + JSON.stringify(obj) + "\n";
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return pad + "[]\n";
    let out = "";
    for (const item of obj) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length > 0) {
          const [firstKey, firstVal] = entries[0];
          if (typeof firstVal === "object" && firstVal !== null) {
            out += pad + "- " + firstKey + ":\n";
            out += yamlSerialize(firstVal, indent + 2);
          } else {
            out += pad + "- " + firstKey + ": " + yamlSerializeInline(firstVal) + "\n";
          }
          for (let i = 1; i < entries.length; i++) {
            const [k, v] = entries[i];
            if (typeof v === "object" && v !== null) {
              out += pad + "  " + k + ":\n";
              out += yamlSerialize(v, indent + 2);
            } else {
              out += pad + "  " + k + ": " + yamlSerializeInline(v) + "\n";
            }
          }
        }
      } else {
        out += pad + "- " + yamlSerializeInline(item) + "\n";
      }
    }
    return out;
  }
  if (typeof obj === "object") {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return pad + "{}\n";
    let out = "";
    for (const [key, val] of entries) {
      if (val === undefined) continue;
      if (typeof val === "object" && val !== null) {
        out += pad + key + ":\n";
        out += yamlSerialize(val, indent + 1);
      } else {
        out += pad + key + ": " + yamlSerializeInline(val) + "\n";
      }
    }
    return out;
  }
  return pad + String(obj) + "\n";
}

function yamlSerializeInline(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") {
    if (val.includes("\n") || val.includes('"') || val.includes(":") || val.includes("#") || val === "") {
      return JSON.stringify(val);
    }
    return JSON.stringify(val);
  }
  return JSON.stringify(val);
}

function yamlParse(text: string): unknown {
  // Simple YAML parser for the workshop structure
  const lines = text.split("\n");
  return parseYamlLines(lines, 0, 0).value;
}

interface ParseResult {
  value: unknown;
  nextLine: number;
}

function getIndent(line: string): number {
  const match = line.match(/^( *)/);
  return match ? match[1].length : 0;
}

function parseYamlLines(lines: string[], startLine: number, baseIndent: number): ParseResult {
  // Skip empty lines and comments
  let i = startLine;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("#"))) i++;
  if (i >= lines.length) return { value: null, nextLine: i };

  const line = lines[i];
  const trimmed = line.trim();

  // Detect if this is a list
  if (trimmed.startsWith("- ")) {
    return parseYamlArray(lines, i, getIndent(line));
  }
  // Detect if this is an empty array
  if (trimmed === "[]") return { value: [], nextLine: i + 1 };
  if (trimmed === "{}") return { value: {}, nextLine: i + 1 };

  // Detect if this is a mapping
  if (trimmed.includes(":")) {
    return parseYamlObject(lines, i, baseIndent);
  }

  // Scalar
  return { value: parseYamlScalar(trimmed), nextLine: i + 1 };
}

function parseYamlObject(lines: string[], startLine: number, baseIndent: number): ParseResult {
  const obj: Record<string, unknown> = {};
  let i = startLine;

  while (i < lines.length) {
    if (lines[i].trim() === "" || lines[i].trim().startsWith("#")) { i++; continue; }
    const indent = getIndent(lines[i]);
    if (indent < baseIndent) break;
    if (indent > baseIndent && i > startLine) break;

    const trimmed = lines[i].trim();
    if (trimmed.startsWith("- ")) break; // This is a list item, not an object key

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const afterColon = trimmed.slice(colonIdx + 1).trim();

    if (afterColon === "|") {
      // Block scalar
      i++;
      let blockLines: string[] = [];
      const blockIndent = i < lines.length ? getIndent(lines[i]) : indent + 2;
      while (i < lines.length) {
        const lineIndent = getIndent(lines[i]);
        if (lines[i].trim() === "") {
          blockLines.push("");
          i++;
          continue;
        }
        if (lineIndent < blockIndent) break;
        blockLines.push(lines[i].slice(blockIndent));
        i++;
      }
      // Remove trailing empty lines
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") blockLines.pop();
      obj[key] = blockLines.join("\n");
    } else if (afterColon === "" || afterColon === "[]" || afterColon === "{}") {
      if (afterColon === "[]") { obj[key] = []; i++; continue; }
      if (afterColon === "{}") { obj[key] = {}; i++; continue; }
      // Value is on next line(s)
      i++;
      if (i < lines.length && lines[i].trim() !== "") {
        const nextIndent = getIndent(lines[i]);
        if (nextIndent > indent) {
          const result = parseYamlLines(lines, i, nextIndent);
          obj[key] = result.value;
          i = result.nextLine;
        }
      }
    } else {
      obj[key] = parseYamlScalar(afterColon);
      i++;
    }
  }

  return { value: obj, nextLine: i };
}

function parseYamlArray(lines: string[], startLine: number, baseIndent: number): ParseResult {
  const arr: unknown[] = [];
  let i = startLine;

  while (i < lines.length) {
    if (lines[i].trim() === "" || lines[i].trim().startsWith("#")) { i++; continue; }
    const indent = getIndent(lines[i]);
    if (indent < baseIndent) break;
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("- ")) break;

    const afterDash = trimmed.slice(2).trim();

    // Check if this is a mapping item (key: value after dash)
    const colonIdx = afterDash.indexOf(":");
    if (colonIdx > 0 && !afterDash.startsWith('"') && !afterDash.startsWith("'")) {
      // Inline mapping start — gather the whole item
      const itemObj: Record<string, unknown> = {};
      const firstKey = afterDash.slice(0, colonIdx).trim();
      const firstVal = afterDash.slice(colonIdx + 1).trim();

      if (firstVal === "" || firstVal === "|") {
        if (firstVal === "|") {
          i++;
          let blockLines: string[] = [];
          const blockIndent = i < lines.length ? getIndent(lines[i]) : indent + 4;
          while (i < lines.length) {
            if (lines[i].trim() === "") { blockLines.push(""); i++; continue; }
            if (getIndent(lines[i]) < blockIndent) break;
            blockLines.push(lines[i].slice(blockIndent));
            i++;
          }
          while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") blockLines.pop();
          itemObj[firstKey] = blockLines.join("\n");
        } else {
          i++;
          if (i < lines.length) {
            const nextIndent = getIndent(lines[i]);
            if (nextIndent > indent + 2) {
              const result = parseYamlLines(lines, i, nextIndent);
              itemObj[firstKey] = result.value;
              i = result.nextLine;
            } else {
              i++;
            }
          }
        }
      } else {
        itemObj[firstKey] = parseYamlScalar(firstVal);
        i++;
      }

      // Read remaining keys at indent + 2
      const itemIndent = indent + 2;
      while (i < lines.length) {
        if (lines[i].trim() === "" || lines[i].trim().startsWith("#")) { i++; continue; }
        if (getIndent(lines[i]) < itemIndent) break;
        if (getIndent(lines[i]) === indent && lines[i].trim().startsWith("- ")) break;

        const itemTrimmed = lines[i].trim();
        const itemColonIdx = itemTrimmed.indexOf(":");
        if (itemColonIdx === -1) { i++; continue; }

        const k = itemTrimmed.slice(0, itemColonIdx).trim();
        const v = itemTrimmed.slice(itemColonIdx + 1).trim();

        if (v === "|") {
          i++;
          let blockLines: string[] = [];
          const blockIndent = i < lines.length ? getIndent(lines[i]) : indent + 4;
          while (i < lines.length) {
            if (lines[i].trim() === "") { blockLines.push(""); i++; continue; }
            if (getIndent(lines[i]) < blockIndent) break;
            blockLines.push(lines[i].slice(blockIndent));
            i++;
          }
          while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") blockLines.pop();
          itemObj[k] = blockLines.join("\n");
        } else if (v === "" || v === "[]" || v === "{}") {
          if (v === "[]") { itemObj[k] = []; i++; continue; }
          if (v === "{}") { itemObj[k] = {}; i++; continue; }
          i++;
          if (i < lines.length && lines[i].trim() !== "") {
            const nextIndent = getIndent(lines[i]);
            if (nextIndent > getIndent(lines[i - 1])) {
              const result = parseYamlLines(lines, i, nextIndent);
              itemObj[k] = result.value;
              i = result.nextLine;
            }
          }
        } else {
          itemObj[k] = parseYamlScalar(v);
          i++;
        }
      }

      arr.push(itemObj);
    } else {
      // Simple scalar list item
      arr.push(parseYamlScalar(afterDash));
      i++;
    }
  }

  return { value: arr, nextLine: i };
}

function parseYamlScalar(s: string): string | number | boolean | null {
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  // Strip quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

// --- CORS helper ---

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// --- HTML page ---

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Workshop</title>
<style>
  :root {
    --bg: #0d1117; --bg-card: #161b22; --bg-card-hover: #1c2333;
    --bg-sidebar: #0d1117; --bg-sidebar-item: #161b22; --bg-sidebar-active: #1c2333;
    --border: #30363d; --border-highlight: #58a6ff;
    --text: #e6edf3; --text-muted: #8b949e; --text-dim: #6e7681;
    --accent: #58a6ff; --accent-soft: rgba(88,166,255,0.15);
    --green: #3fb950; --orange: #d29922; --red: #f85149; --purple: #bc8cff;
    --radius: 8px; --sidebar-w: 260px; --chat-w: 300px;
  }
  :root.light {
    --bg: #ffffff; --bg-card: #f6f8fa; --bg-card-hover: #eef1f5;
    --bg-sidebar: #f6f8fa; --bg-sidebar-item: #eef1f5; --bg-sidebar-active: #e2e6ea;
    --border: #d0d7de; --border-highlight: #0969da;
    --text: #1f2328; --text-muted: #656d76; --text-dim: #8b949e;
    --accent: #0969da; --accent-soft: rgba(9,105,218,0.12);
    --green: #1a7f37; --orange: #9a6700; --red: #cf222e; --purple: #8250df;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); height: 100vh; overflow: hidden;
    display: flex;
  }

  /* Sidebar */
  #sidebar {
    width: var(--sidebar-w); min-width: var(--sidebar-w); height: 100vh;
    background: var(--bg-sidebar); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden;
  }
  #sidebar-header {
    padding: 16px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
  }
  #sidebar-header h1 {
    font-size: 15px; font-weight: 600;
    display: flex; align-items: center; gap: 8px;
  }
  #theme-toggle {
    background: none; border: 1px solid var(--border); color: var(--text-dim);
    padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 13px;
  }
  #theme-toggle:hover { color: var(--text); border-color: var(--border-highlight); }
  #sidebar-header .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--green); animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
  #workshop-title {
    font-size: 12px; color: var(--text-muted); margin-top: 6px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #workshop-status {
    font-size: 10px; margin-top: 4px; display: flex; align-items: center; gap: 6px;
  }
  .status-badge {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    padding: 1px 6px; border-radius: 3px;
  }
  .status-badge.preparing { background: rgba(210,153,34,0.15); color: var(--orange); }
  .status-badge.ready { background: rgba(88,166,255,0.15); color: var(--accent); }
  .status-badge.active { background: rgba(63,185,80,0.15); color: var(--green); }
  .status-badge.finalized { background: rgba(188,140,255,0.15); color: var(--purple); }

  /* Slide list */
  #slide-list {
    flex: 1; overflow-y: auto; padding: 8px;
  }
  #slide-list::-webkit-scrollbar { width: 4px; }
  #slide-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .slide-item {
    padding: 10px 12px; margin-bottom: 4px; border-radius: 6px;
    cursor: pointer; transition: all 0.15s; border: 1px solid transparent;
  }
  .slide-item:hover { background: var(--bg-sidebar-item); }
  .slide-item.active { background: var(--bg-sidebar-active); border-color: var(--accent); }
  .slide-item-title {
    font-size: 13px; font-weight: 500; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .slide-item-meta {
    font-size: 10px; color: var(--text-dim); margin-top: 3px;
    display: flex; align-items: center; gap: 6px;
  }
  .slide-item-meta .tile-count {
    background: var(--accent-soft); color: var(--accent);
    padding: 0 5px; border-radius: 6px;
  }
  .slide-item-order {
    font-size: 10px; color: var(--text-dim); font-weight: 600;
    width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;
    border-radius: 4px; background: var(--accent-soft); color: var(--accent);
  }

  /* Finalize button */
  #sidebar-footer {
    padding: 12px; border-top: 1px solid var(--border);
  }
  #finalize-btn {
    width: 100%; padding: 8px; background: var(--accent-soft); color: var(--accent);
    border: 1px solid var(--accent); border-radius: 6px; cursor: pointer;
    font-size: 12px; font-weight: 600; transition: all 0.15s;
  }
  #finalize-btn:hover { background: var(--accent); color: #fff; }

  /* Main area */
  #main {
    flex: 1; height: 100vh; overflow-y: auto; padding: 24px 32px;
  }
  #main::-webkit-scrollbar { width: 6px; }
  #main::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  #slide-header {
    margin-bottom: 20px; display: flex; align-items: baseline; justify-content: space-between;
  }
  #slide-title { font-size: 20px; font-weight: 600; }
  #slide-meta { font-size: 12px; color: var(--text-dim); }

  /* Tile grid */
  #tile-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
  }
  .tile-card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: var(--radius); overflow: visible; transition: border-color 0.15s;
    position: relative;
  }
  .tile-card:hover { border-color: var(--border-highlight); }
  .tile-card.full { grid-column: 1 / -1; }
  .tile-card-header {
    padding: 8px 14px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between;
  }
  .tile-card-header-left { display: flex; align-items: center; gap: 8px; }
  .tile-card-title { font-size: 12px; font-weight: 500; color: var(--text-muted); }
  .tile-badge {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    padding: 1px 5px; border-radius: 3px;
  }
  .tile-badge.mermaid { background: rgba(63,185,80,0.15); color: var(--green); }
  .tile-badge.kroki { background: rgba(188,140,255,0.15); color: var(--purple); }
  .tile-badge.html { background: rgba(210,153,34,0.15); color: var(--orange); }
  .tile-badge.svg { background: var(--accent-soft); color: var(--accent); }
  .tile-badge.markdown { background: rgba(210,153,34,0.15); color: var(--orange); }
  .tile-actions { display: flex; align-items: center; gap: 4px; }
  .tile-actions button {
    background: none; border: none; color: var(--text-dim);
    cursor: pointer; padding: 2px 6px; font-size: 12px; border-radius: 3px;
  }
  .tile-actions button:hover { background: var(--bg-card-hover); color: var(--text); }
  .tile-actions button.active-toggle { color: var(--accent); }
  .tile-card-body {
    padding: 14px; overflow: auto;
  }

  /* Tile resize handles */
  .tile-resize-handle {
    position: absolute; left: 0; right: 0; height: 8px; z-index: 10;
    cursor: ns-resize; display: flex; align-items: center; justify-content: center;
    bottom: -4px;
  }
  .tile-resize-handle::after {
    content: ''; width: 40px; height: 3px; border-radius: 2px;
    background: var(--border); transition: background 0.15s, width 0.15s;
  }
  .tile-resize-handle:hover::after, .tile-resize-handle.active::after {
    background: var(--accent); width: 60px;
  }

  /* Diagram viewport */
  .diagram-viewport { position: relative; height: 400px; overflow: hidden; cursor: grab; }
  .diagram-viewport.grabbing { cursor: grabbing; }
  .diagram-viewport .diagram-inner { transform-origin: 0 0; }
  .diagram-viewport .diagram-inner svg { max-width: none; max-height: none; }
  .diagram-hint {
    position: absolute; bottom: 6px; left: 50%; transform: translateX(-50%);
    font-size: 10px; color: var(--text-dim); pointer-events: none; opacity: 0.7;
  }

  /* Markdown rendering */
  .markdown-container { line-height: 1.6; font-size: 14px; }
  .markdown-container h1 { font-size: 1.4em; margin: 16px 0 8px; }
  .markdown-container h2 { font-size: 1.2em; margin: 14px 0 6px; color: var(--text); }
  .markdown-container h3 { font-size: 1.05em; margin: 10px 0 4px; color: var(--text-muted); }
  .markdown-container p { margin: 0 0 8px; }
  .markdown-container ul, .markdown-container ol { padding-left: 22px; margin: 4px 0 10px; }
  .markdown-container li { margin: 3px 0; }
  .markdown-container code {
    background: rgba(110,118,129,0.25); padding: 2px 6px; border-radius: 3px; font-size: 0.88em;
    font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
  }
  .markdown-container pre {
    background: var(--bg); padding: 14px; border-radius: 6px; overflow-x: auto; margin: 10px 0;
    border: 1px solid var(--border);
  }
  .markdown-container pre code {
    background: none; padding: 0; font-size: 12.5px; line-height: 1.5;
  }
  .markdown-container table {
    width: 100%; border-collapse: collapse; font-size: 13px; margin: 8px 0;
  }
  .markdown-container th {
    padding: 6px 10px; border-bottom: 2px solid var(--border); text-align: left; font-weight: 600; color: var(--text);
  }
  .markdown-container td {
    padding: 5px 10px; border-bottom: 1px solid var(--border); color: var(--text-muted);
  }
  .markdown-container blockquote {
    border-left: 3px solid var(--accent); margin: 8px 0; padding: 4px 14px; color: var(--text-muted);
  }
  .markdown-container hr {
    border: none; border-top: 1px solid var(--border); margin: 12px 0;
  }
  .markdown-container strong { color: var(--text); }
  .markdown-container a { color: var(--accent); }

  /* HTML container */
  .html-container { line-height: 1.5; font-size: 14px; }

  /* Comments section */
  .comments-section {
    border-top: 1px solid var(--border);
  }
  .comments-toggle-bar {
    padding: 6px 14px; font-size: 11px; color: var(--text-dim);
    cursor: pointer; text-align: center; user-select: none;
  }
  .comments-toggle-bar:hover { color: var(--accent); background: var(--accent-soft); }
  .comments-body { padding: 10px 14px; padding-top: 0; }
  .comments-body.hidden { display: none; }
  .comment-item {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; margin-bottom: 6px; font-size: 12px;
  }
  .comment-item-header {
    display: flex; align-items: center; gap: 6px; margin-bottom: 4px;
  }
  .comment-author {
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    padding: 1px 5px; border-radius: 3px;
  }
  .comment-author.user { background: rgba(88,166,255,0.15); color: var(--accent); }
  .comment-author.agent { background: rgba(63,185,80,0.15); color: var(--green); }
  .comment-status {
    font-size: 9px; font-weight: 600; text-transform: uppercase;
    padding: 1px 5px; border-radius: 3px;
  }
  .comment-status.pending { background: rgba(210,153,34,0.15); color: var(--orange); }
  .comment-status.applied { background: rgba(63,185,80,0.15); color: var(--green); }
  .comment-status.removed { background: rgba(248,81,73,0.15); color: var(--red); }
  .comment-content { color: var(--text-muted); line-height: 1.4; }
  .comment-actions {
    margin-top: 4px; display: flex; gap: 6px;
  }
  .comment-actions button {
    font-size: 10px; background: none; border: 1px solid var(--border);
    color: var(--text-dim); padding: 1px 6px; border-radius: 3px; cursor: pointer;
  }
  .comment-actions button:hover { color: var(--text); border-color: var(--border-highlight); }
  .comment-actions button.apply-btn:hover { color: var(--green); border-color: var(--green); }
  .comment-actions button.remove-btn:hover { color: var(--red); border-color: var(--red); }
  .add-comment-row {
    display: flex; flex-direction: column; gap: 6px; margin-top: 8px; align-items: flex-start;
  }
  .add-comment-row textarea {
    width: 100%; box-sizing: border-box; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); padding: 6px 8px; border-radius: 4px; font-size: 12px;
    outline: none; resize: vertical; min-height: 36px; max-height: 120px;
    font-family: inherit; line-height: 1.4;
  }
  .add-comment-row textarea:focus { border-color: var(--accent); }
  .add-comment-row button {
    background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent);
    padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: 600;
  }
  .add-comment-row button:hover { background: var(--accent); color: #fff; }

  /* Chat panel */
  #chat-panel {
    width: var(--chat-w); min-width: 200px; max-width: 500px; height: 100vh;
    background: var(--bg-sidebar); border-left: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden; position: relative;
  }
  #sidebar-resize-handle {
    width: 5px; cursor: ew-resize; z-index: 10;
    background: transparent; transition: background 0.15s;
  }
  #sidebar-resize-handle:hover { background: var(--accent); opacity: 0.3; }
  #chat-resize-handle {
    position: absolute; left: -3px; top: 0; bottom: 0; width: 6px;
    cursor: ew-resize; z-index: 10;
  }
  #chat-resize-handle:hover { background: var(--accent); opacity: 0.3; }
  #chat-header {
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    font-size: 13px; font-weight: 600;
    display: flex; align-items: center; gap: 8px;
  }
  #chat-messages {
    flex: 1; overflow-y: auto; padding: 12px;
  }
  #chat-messages::-webkit-scrollbar { width: 4px; }
  #chat-messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .chat-msg {
    margin-bottom: 10px; display: flex; flex-direction: column; gap: 3px;
  }
  .chat-msg-header {
    display: flex; align-items: center; gap: 6px;
  }
  .chat-msg-author {
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    padding: 1px 5px; border-radius: 3px;
  }
  .chat-msg-author.user { background: rgba(88,166,255,0.15); color: var(--accent); }
  .chat-msg-author.agent { background: rgba(63,185,80,0.15); color: var(--green); }
  .chat-msg-time { font-size: 10px; color: var(--text-dim); }
  .chat-msg-content {
    font-size: 13px; color: var(--text-muted); line-height: 1.4;
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 10px;
  }
  #chat-input-row {
    padding: 12px; border-top: 1px solid var(--border);
    display: flex; flex-direction: column; gap: 6px; align-items: flex-start;
  }
  #chat-input {
    width: 100%; box-sizing: border-box; background: var(--bg-card); border: 1px solid var(--border);
    color: var(--text); padding: 8px 12px; border-radius: 6px; font-size: 13px;
    outline: none; font-family: inherit; resize: vertical; min-height: 40px; max-height: 160px;
    line-height: 1.4;
  }
  #chat-input:focus { border-color: var(--accent); }
  #chat-send-btn {
    background: var(--accent); color: #fff; border: none;
    padding: 8px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
    cursor: pointer; transition: opacity 0.15s;
  }
  #chat-send-btn:hover { opacity: 0.85; }

  /* Empty state */
  .empty-state {
    text-align: center; padding: 60px 24px; color: var(--text-dim); grid-column: 1 / -1;
  }
  .empty-state h2 { font-size: 18px; margin-bottom: 6px; color: var(--text-muted); }
  .empty-state p { font-size: 13px; line-height: 1.6; }
  .empty-state code { background: var(--bg-card); padding: 2px 6px; border-radius: 4px; color: var(--accent); }

  /* Fullscreen overlay */
  .fullscreen-overlay {
    display: none; position: fixed; inset: 0; z-index: 150;
    background: rgba(0,0,0,0.85); backdrop-filter: blur(6px);
    flex-direction: column; align-items: center; justify-content: center;
  }
  .fullscreen-overlay.active { display: flex; }
  .fs-toolbar {
    position: absolute; top: 16px; right: 16px; display: flex; gap: 8px; z-index: 160;
  }
  .fs-toolbar button {
    width: 40px; height: 40px; border: 1px solid rgba(255,255,255,0.2);
    border-radius: 8px; background: rgba(30,41,59,0.9); color: #e2e8f0;
    cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center;
    transition: all 0.15s;
  }
  .fs-toolbar button:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
  .fs-viewport { width: 100%; height: 100%; overflow: hidden; cursor: grab; }
  .fs-viewport.grabbing { cursor: grabbing; }
  .fs-viewport .diagram-inner {
    transform-origin: 0 0; display: flex; align-items: center; justify-content: center;
    min-width: 100%; min-height: 100%;
  }
  .fs-hint {
    position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
    color: rgba(255,255,255,0.45); font-size: 12px; pointer-events: none; z-index: 160;
  }
  .toast {
    position: fixed; bottom: 20px; right: 20px;
    background: var(--bg-card); border: 1px solid var(--green);
    color: var(--green); padding: 8px 16px; border-radius: var(--radius);
    font-size: 13px; opacity: 0; transform: translateY(10px);
    transition: all 0.3s; pointer-events: none; z-index: 200;
  }
  .toast.show { opacity: 1; transform: translateY(0); }

  /* Finalize modal */
  .modal-overlay {
    display: none; position: fixed; inset: 0; z-index: 200;
    background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
    align-items: center; justify-content: center;
  }
  .modal-overlay.active { display: flex; }
  .modal-box {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 24px; min-width: 380px;
  }
  .modal-box h3 { font-size: 16px; margin-bottom: 16px; }
  .modal-box label {
    display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px;
  }
  .modal-box input {
    width: 100%; background: var(--bg); border: 1px solid var(--border);
    color: var(--text); padding: 8px 10px; border-radius: 4px; font-size: 13px;
    outline: none; margin-bottom: 12px;
  }
  .modal-box input:focus { border-color: var(--accent); }
  .modal-btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .modal-btns button {
    padding: 8px 16px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .modal-btn-cancel {
    background: none; border: 1px solid var(--border); color: var(--text-muted);
  }
  .modal-btn-cancel:hover { color: var(--text); border-color: var(--border-highlight); }
  .modal-btn-confirm {
    background: var(--accent); color: #fff; border: none;
  }
  .modal-btn-confirm:hover { opacity: 0.85; }
</style>
</head>
<body>
<div id="sidebar">
  <div id="sidebar-header">
    <h1><span class="dot"></span> Workshop</h1>
    <button id="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode">&#9788;</button>
  </div>
  <div style="padding: 8px 16px; border-bottom: 1px solid var(--border);">
    <div id="workshop-title">Loading...</div>
    <div id="workshop-status"></div>
  </div>
  <div id="slide-list"></div>
  <div id="sidebar-footer">
    <button id="finalize-btn" onclick="openFinalizeModal()">Finalize Workshop</button>
  </div>
</div>
<div id="sidebar-resize-handle"></div>
<div id="main">
  <div id="slide-header" style="display:none">
    <div id="slide-title"></div>
    <div id="slide-meta"></div>
  </div>
  <div id="tile-grid">
    <div class="empty-state" id="empty">
      <h2>Waiting for content...</h2>
      <p>The agent will push slides and tiles here as the workshop is prepared.<br>Content appears automatically via live updates.</p>
    </div>
  </div>
</div>
<div id="chat-panel">
  <div id="chat-resize-handle"></div>
  <div id="chat-header">Chat</div>
  <div id="chat-messages"></div>
  <div id="chat-input-row">
    <textarea id="chat-input" placeholder="Type a message... (Ctrl+Enter to send)" rows="2"></textarea>
    <button id="chat-send-btn" onclick="sendChat()">Send</button>
  </div>
</div>

<div class="fullscreen-overlay" id="fullscreen">
  <div class="fs-toolbar">
    <button onclick="fsZoom(1.3)" title="Zoom in">+</button>
    <button onclick="fsZoom(1/1.3)" title="Zoom out">&minus;</button>
    <button onclick="fsReset()" title="Reset zoom">1:1</button>
    <button onclick="closeFullscreen()" title="Close (Esc)">&times;</button>
  </div>
  <div class="fs-viewport" id="fs-viewport">
    <div class="diagram-inner" id="fs-inner"></div>
  </div>
  <div class="fs-hint">Scroll to zoom &middot; Drag to pan &middot; Esc to close</div>
</div>
<div class="toast" id="toast"></div>

<div class="modal-overlay" id="finalize-modal">
  <div class="modal-box">
    <h3>Finalize Workshop</h3>
    <label>Output directory</label>
    <input type="text" id="finalize-dir" value="docs/workshops" />
    <label>Slug</label>
    <input type="text" id="finalize-slug" value="my-workshop" />
    <div class="modal-btns">
      <button class="modal-btn-cancel" onclick="closeFinalizeModal()">Cancel</button>
      <button class="modal-btn-confirm" onclick="doFinalize()">Finalize</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="pending-load-modal">
  <div class="modal-box">
    <h3>Load a different workshop?</h3>
    <div id="pending-load-body" style="color: var(--text-muted); margin-bottom: 16px; font-size: 13px; line-height: 1.6;"></div>
    <div class="modal-btns">
      <button class="modal-btn-cancel" onclick="declinePendingLoad()">Keep current</button>
      <button class="modal-btn-confirm" onclick="acceptPendingLoad()">Discard &amp; load new</button>
    </div>
  </div>
</div>

<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15/lib/marked.esm.js';
mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
marked.setOptions({ breaks: false, gfm: true });

const slideListEl = document.getElementById('slide-list');
const tileGridEl = document.getElementById('tile-grid');
const emptyEl = document.getElementById('empty');
const slideHeaderEl = document.getElementById('slide-header');
const slideTitleEl = document.getElementById('slide-title');
const slideMetaEl = document.getElementById('slide-meta');
const workshopTitleEl = document.getElementById('workshop-title');
const workshopStatusEl = document.getElementById('workshop-status');
const chatMessagesEl = document.getElementById('chat-messages');
const chatInputEl = document.getElementById('chat-input');
const fullscreenEl = document.getElementById('fullscreen');
const fsViewportEl = document.getElementById('fs-viewport');
const fsInnerEl = document.getElementById('fs-inner');
const toastEl = document.getElementById('toast');

let state = { workshop: null, inbox: [], pendingLoad: null };
let activeSlideId = null;
const cardZoomStates = new Map();
const commentDrafts = new Map();

window.updateCommentDraft = function(tileId, value) {
  if (value) commentDrafts.set(tileId, value);
  else commentDrafts.delete(tileId);
};

/* -- Theme toggle -- */
window.toggleTheme = function() {
  document.documentElement.classList.toggle('light');
  const isLight = document.documentElement.classList.contains('light');
  localStorage.setItem('workshop-theme', isLight ? 'light' : 'dark');
  document.getElementById('theme-toggle').textContent = isLight ? '\u263E' : '\u2606';
};
(function initTheme() {
  if (localStorage.getItem('workshop-theme') === 'light') {
    document.documentElement.classList.add('light');
    var btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = '\u263E';
  }
})();

/* -- Zoom/pan helpers -- */
function applyTransform(innerEl, st) {
  innerEl.style.transform = 'translate(' + st.tx + 'px,' + st.ty + 'px) scale(' + st.scale + ')';
}
function makeZoomState() {
  return { scale:1, tx:0, ty:0, dragging:false, dragStartX:0, dragStartY:0, dragTxStart:0, dragTyStart:0 };
}
function setupZoomPan(viewport, innerEl, st) {
  viewport.addEventListener('wheel', function(e) {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.min(Math.max(st.scale * factor, 0.1), 10);
    st.tx = mx - (mx - st.tx) * (newScale / st.scale);
    st.ty = my - (my - st.ty) * (newScale / st.scale);
    st.scale = newScale;
    applyTransform(innerEl, st);
  }, { passive: false });
  viewport.addEventListener('mousedown', function(e) {
    if (e.target.closest('button')) return;
    st.dragging = true; st.dragStartX = e.clientX; st.dragStartY = e.clientY;
    st.dragTxStart = st.tx; st.dragTyStart = st.ty;
    viewport.classList.add('grabbing');
  });
  window.addEventListener('mousemove', function(e) {
    if (!st.dragging) return;
    st.tx = st.dragTxStart + (e.clientX - st.dragStartX);
    st.ty = st.dragTyStart + (e.clientY - st.dragStartY);
    applyTransform(innerEl, st);
  });
  window.addEventListener('mouseup', function() {
    if (st.dragging) { st.dragging = false; viewport.classList.remove('grabbing'); }
  });
}
function fitDiagramToViewport(viewport, innerEl, st) {
  requestAnimationFrame(() => {
    const svg = innerEl.querySelector('svg');
    if (!svg) return;
    const vpRect = viewport.getBoundingClientRect();
    const w = svg.viewBox?.baseVal?.width || svg.width?.baseVal?.value || svg.getBoundingClientRect().width;
    const h = svg.viewBox?.baseVal?.height || svg.height?.baseVal?.value || svg.getBoundingClientRect().height;
    if (w > 0 && h > 0) {
      state.scale = Math.min(vpRect.width / w, vpRect.height / h, 1) * 0.95;
      st.scale = Math.min(vpRect.width / w, vpRect.height / h, 1) * 0.95;
      st.tx = (vpRect.width - w * st.scale) / 2;
      st.ty = (vpRect.height - h * st.scale) / 2;
      applyTransform(innerEl, st);
    }
  });
}

// Fullscreen
const fsState = makeZoomState();
setupZoomPan(fsViewportEl, fsInnerEl, fsState);
window.fsZoom = function(factor) {
  fsState.scale = Math.min(Math.max(fsState.scale * factor, 0.1), 10);
  applyTransform(fsInnerEl, fsState);
};
window.fsReset = function() {
  Object.assign(fsState, makeZoomState());
  fitDiagramToViewport(fsViewportEl, fsInnerEl, fsState);
};
window.closeFullscreen = function() { fullscreenEl.classList.remove('active'); };

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2000);
}

/* -- Tile card resize -- */
(function() {
  let tileResizing = null;
  document.addEventListener('mousedown', function(e) {
    const handle = e.target.closest('.tile-resize-handle');
    if (!handle) return;
    e.preventDefault();
    const tileId = handle.dataset.tileId;
    const cardBody = document.getElementById('body-' + tileId);
    if (!cardBody) return;
    const currentH = cardBody.getBoundingClientRect().height;
    cardBody.style.height = currentH + 'px';
    const vp = cardBody.querySelector('.diagram-viewport');
    if (vp) vp.style.height = (currentH - 28) + 'px';
    tileResizing = { cardBody: cardBody, viewport: vp, startY: e.clientY, startH: currentH };
    handle.classList.add('active');
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', function(e) {
    if (!tileResizing) return;
    const delta = e.clientY - tileResizing.startY;
    const newH = Math.max(80, tileResizing.startH + delta);
    tileResizing.cardBody.style.height = newH + 'px';
    if (tileResizing.viewport) tileResizing.viewport.style.height = (newH - 28) + 'px';
  });
  document.addEventListener('mouseup', function() {
    if (!tileResizing) return;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.querySelectorAll('.tile-resize-handle.active').forEach(function(el) { el.classList.remove('active'); });
    tileResizing = null;
  });
})();

/* -- Sidebar resize handle -- */
(function setupSidebarResize() {
  const handle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.getElementById('sidebar');
  let resizing = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault(); resizing = true; startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    document.body.style.cursor = 'ew-resize'; document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', function(e) {
    if (!resizing) return;
    const newW = Math.min(Math.max(startW + (e.clientX - startX), 180), 500);
    sidebar.style.width = newW + 'px';
    sidebar.style.minWidth = newW + 'px';
  });
  window.addEventListener('mouseup', function() {
    if (resizing) { resizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  });
})();

/* -- Chat resize handle -- */
(function setupChatResize() {
  const handle = document.getElementById('chat-resize-handle');
  const panel = document.getElementById('chat-panel');
  let resizing = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault(); resizing = true; startX = e.clientX;
    startW = panel.getBoundingClientRect().width;
    document.body.style.cursor = 'ew-resize'; document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', function(e) {
    if (!resizing) return;
    const newW = Math.min(Math.max(startW - (e.clientX - startX), 200), 500);
    panel.style.width = newW + 'px';
    panel.style.minWidth = newW + 'px';
  });
  window.addEventListener('mouseup', function() {
    if (resizing) { resizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; }
  });
})();

/* -- SSE -- */
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('workshop-update', (e) => {
    const data = JSON.parse(e.data);
    state = data;
    render();
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 2000);
  };
}

/* -- Hydrate -- */
async function hydrate() {
  try {
    const [wsRes, chatRes] = await Promise.all([fetch('/api/workshop'), fetch('/api/chat')]);
    const ws = await wsRes.json();
    const chat = await chatRes.json();
    state.workshop = ws;
    state.workshop.chat = chat;
    render();
  } catch {}
  connectSSE();
}

/* -- Render -- */
function render() {
  renderPendingLoadModal();

  const ws = state.workshop;
  if (!ws) return;

  workshopTitleEl.textContent = ws.title;
  workshopStatusEl.innerHTML = '<span class="status-badge ' + ws.status + '">' + ws.status + '</span>';

  renderSidebar(ws);

  const slide = ws.slides.find(s => s.id === activeSlideId);
  if (slide) {
    renderSlide(slide);
  } else if (ws.slides.length > 0) {
    activeSlideId = ws.slides[0].id;
    renderSlide(ws.slides[0]);
  } else {
    slideHeaderEl.style.display = 'none';
    tileGridEl.innerHTML = '<div class="empty-state" id="empty"><h2>Waiting for content...</h2><p>The agent will push slides and tiles here.</p></div>';
  }

  renderChat(ws.chat || []);
}

function renderSidebar(ws) {
  const sorted = [...ws.slides].sort((a, b) => a.order - b.order);
  let html = '';
  for (const slide of sorted) {
    const active = slide.id === activeSlideId;
    html += '<div class="slide-item' + (active ? ' active' : '') + '" onclick="selectSlide(\\'' + slide.id + '\\')">'
      + '<div style="display:flex;align-items:center;gap:8px">'
      + '<span class="slide-item-order">' + slide.order + '</span>'
      + '<div class="slide-item-title">' + escapeHtml(slide.title) + '</div>'
      + '</div>'
      + '<div class="slide-item-meta">'
      + '<span class="tile-count">' + slide.tiles.length + ' tile' + (slide.tiles.length !== 1 ? 's' : '') + '</span>'
      + '</div></div>';
  }
  slideListEl.innerHTML = html;
}

window.selectSlide = function(slideId) {
  activeSlideId = slideId;
  render();
};

async function renderSlide(slide) {
  slideTitleEl.textContent = slide.title;
  slideMetaEl.textContent = 'Slide ' + slide.order + ' / ' + slide.tiles.length + ' tile' + (slide.tiles.length !== 1 ? 's' : '');
  slideHeaderEl.style.display = 'flex';

  // (hiddenComments set persists across re-renders — declared globally)

  // Capture focused comment textarea so we can restore it after the rebuild
  let focusInfo = null;
  const active = document.activeElement;
  if (active && active.id && active.id.indexOf('comment-input-') === 0) {
    focusInfo = {
      tileId: active.id.slice('comment-input-'.length),
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }

  tileGridEl.innerHTML = '';
  if (slide.tiles.length === 0) {
    tileGridEl.innerHTML = '<div class="empty-state"><h2>No tiles yet</h2><p>Tiles will appear here as the agent adds content to this slide.</p></div>';
    return;
  }

  for (let i = 0; i < slide.tiles.length; i++) {
    const tile = slide.tiles[i];
    const tileEl = document.createElement('div');
    const badgeClass = tile.type;
    const badgeLabel = tile.type === 'kroki' ? (tile.krokiDiagramType || 'kroki') : tile.type;
    tileEl.className = 'tile-card' + (tile.size === 'full' ? ' full' : '');
    const commentsCount = tile.comments ? tile.comments.length : 0;

    tileEl.innerHTML =
      '<div class="tile-card-header">'
      + '<div class="tile-card-header-left">'
      + '<span class="tile-badge ' + badgeClass + '">' + badgeLabel + '</span>'
      + (tile.title ? '<span class="tile-card-title">' + escapeHtml(tile.title) + '</span>' : '')
      + '</div>'
      + '<div class="tile-actions">'
      + '<button onclick="expandTile(\\'' + slide.id + '\\',\\'' + tile.id + '\\')" title="Fullscreen">&#9974;</button>'
      + '</div></div>'
      + '<div class="tile-card-body" id="body-' + tile.id + '"><div class="render-target" id="rt-' + tile.id + '"></div></div>'
      + '<div class="tile-resize-handle" data-tile-id="' + tile.id + '"></div>'
      + '<div class="comments-section">'
      + '<div class="comments-toggle-bar" onclick="toggleComments(\\'' + tile.id + '\\')">'
      + 'Comments' + (tile.comments && tile.comments.length > 0 ? ' (' + tile.comments.length + ')' : '')
      + '</div>'
      + '<div class="comments-body" id="comments-body-' + tile.id + '">'
      + renderCommentsHtml(slide.id, tile)
      + '</div></div>';
    tileGridEl.appendChild(tileEl);
  }

  // Render tile contents
  for (const tile of slide.tiles) {
    await renderTileContent(tile, 'rt-' + tile.id);
  }

  // Restore hidden comment sections
  hiddenComments.forEach(function(tileId) {
    const el = document.getElementById('comments-body-' + tileId);
    if (el) el.classList.add('hidden');
  });

  // Restore focus + caret on the comment textarea the user was typing in
  if (focusInfo) {
    const el = document.getElementById('comment-input-' + focusInfo.tileId);
    if (el) {
      el.focus();
      try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch {}
    }
  }
}

function renderCommentsHtml(slideId, tile) {
  let html = '';
  if (tile.comments && tile.comments.length > 0) {
    for (const c of tile.comments) {
      html += '<div class="comment-item">'
        + '<div class="comment-item-header">'
        + '<span class="comment-author ' + c.author + '">' + c.author + '</span>'
        + '<span class="comment-status ' + c.status + '">' + c.status + '</span>'
        + '</div>'
        + '<div class="comment-content">' + escapeHtml(c.content) + '</div>';
      if (c.status === 'pending') {
        html += '<div class="comment-actions">'
          + '<button class="apply-btn" onclick="applyComment(\\'' + tile.id + '\\',\\'' + c.id + '\\')">Apply</button>'
          + '<button class="remove-btn" onclick="removeComment(\\'' + tile.id + '\\',\\'' + c.id + '\\')">Remove</button>'
          + '</div>';
      }
      html += '</div>';
    }
  }
  const draft = commentDrafts.get(tile.id) || '';
  html += '<div class="add-comment-row">'
    + '<textarea id="comment-input-' + tile.id + '" placeholder="Add a comment... (Ctrl+Enter to submit)" rows="2"'
    + ' oninput="updateCommentDraft(\\'' + tile.id + '\\', this.value)"'
    + ' onkeydown="if(event.ctrlKey&&event.key===\\'Enter\\'){event.preventDefault();addComment(\\'' + slideId + '\\',\\'' + tile.id + '\\');}">'
    + escapeHtml(draft)
    + '</textarea>'
    + '<button onclick="addComment(\\'' + slideId + '\\',\\'' + tile.id + '\\')">Add</button>'
    + '</div>';
  return html;
}

async function renderTileContent(tile, targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const isDiagram = tile.type === 'mermaid' || tile.type === 'kroki' || tile.type === 'svg';

  if (tile.type === 'mermaid') {
    try {
      const { svg } = await mermaid.render('m-' + targetId, tile.content);
      target.innerHTML = '<div class="diagram-viewport" id="vp-' + targetId + '"><div class="diagram-inner" id="di-' + targetId + '">' + svg + '</div><div class="diagram-hint">Scroll to zoom \\u00b7 Drag to pan</div></div>';
    } catch (err) {
      target.innerHTML = '<pre style="color:var(--red)">' + escapeHtml(err.message) + '</pre><pre>' + escapeHtml(tile.content) + '</pre>';
    }
  } else if (tile.type === 'kroki') {
    const fmt = tile.krokiOutputFormat || 'svg';
    const dtype = tile.krokiDiagramType || 'graphviz';
    try {
      const res = await fetch('https://kroki.io/' + dtype + '/' + fmt, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: tile.content
      });
      if (fmt === 'svg') {
        const svgText = await res.text();
        target.innerHTML = '<div class="diagram-viewport" id="vp-' + targetId + '"><div class="diagram-inner" id="di-' + targetId + '">' + svgText + '</div><div class="diagram-hint">Scroll to zoom \\u00b7 Drag to pan</div></div>';
      } else {
        target.innerHTML = '<div class="kroki-container"><img src="' + URL.createObjectURL(await res.blob()) + '" /></div>';
      }
    } catch (err) {
      target.innerHTML = '<pre style="color:var(--red)">Kroki error: ' + escapeHtml(err.message) + '</pre>';
    }
  } else if (tile.type === 'html') {
    target.innerHTML = '<div class="html-container">' + tile.content + '</div>';
  } else if (tile.type === 'svg') {
    target.innerHTML = '<div class="diagram-viewport" id="vp-' + targetId + '"><div class="diagram-inner" id="di-' + targetId + '">' + tile.content + '</div><div class="diagram-hint">Scroll to zoom \\u00b7 Drag to pan</div></div>';
  } else if (tile.type === 'markdown') {
    target.innerHTML = '<div class="markdown-container">' + marked.parse(tile.content) + '</div>';
  }

  if (isDiagram) {
    const vp = document.getElementById('vp-' + targetId);
    const inner = document.getElementById('di-' + targetId);
    if (vp && inner) {
      const st = makeZoomState();
      cardZoomStates.set(targetId, st);
      setupZoomPan(vp, inner, st);
      fitDiagramToViewport(vp, inner, st);
    }
  }
}

/* -- Chat -- */
function renderChat(messages) {
  let html = '';
  for (const msg of messages) {
    const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    html += '<div class="chat-msg">'
      + '<div class="chat-msg-header">'
      + '<span class="chat-msg-author ' + msg.author + '">' + msg.author + '</span>'
      + '<span class="chat-msg-time">' + time + '</span>'
      + '</div>'
      + '<div class="chat-msg-content">' + escapeHtml(msg.content) + '</div>'
      + '</div>';
  }
  chatMessagesEl.innerHTML = html;
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

window.sendChat = async function() {
  const content = chatInputEl.value.trim();
  if (!content) return;
  chatInputEl.value = '';
  try {
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'user', content })
    });
  } catch (err) {
    showToast('Failed to send message');
  }
};

chatInputEl.addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); sendChat(); }
});

/* -- Comments -- */
const hiddenComments = new Set();

window.toggleComments = function(tileId) {
  const body = document.getElementById('comments-body-' + tileId);
  if (!body) return;
  if (body.classList.contains('hidden')) {
    body.classList.remove('hidden');
    hiddenComments.delete(tileId);
  } else {
    body.classList.add('hidden');
    hiddenComments.add(tileId);
  }
};

window.addComment = async function(slideId, tileId) {
  const input = document.getElementById('comment-input-' + tileId);
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  commentDrafts.delete(tileId);
  try {
    const res = await fetch('/api/tiles/' + tileId + '/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author: 'user', content })
    });
    const data = await res.json();
    if (data.ok) {
      // Optimistic local update — SSE may have already added it during the await
      const ws = state.workshop;
      if (ws) {
        for (const slide of ws.slides) {
          const tile = slide.tiles.find(t => t.id === tileId);
          if (tile) {
            if (!tile.comments.find(c => c.id === data.id)) {
              tile.comments.push({ id: data.id, author: 'user', content: content, status: 'pending', createdAt: new Date().toISOString() });
            }
            const bodyEl = document.getElementById('comments-body-' + tileId);
            if (bodyEl) bodyEl.innerHTML = renderCommentsHtml(slideId, tile);
            const section = bodyEl && bodyEl.parentElement;
            if (section) {
              const bar = section.querySelector('.comments-toggle-bar');
              if (bar) bar.textContent = 'Comments (' + tile.comments.length + ')';
            }
            break;
          }
        }
      }
    }
  } catch (err) {
    showToast('Failed to add comment');
  }
};

window.applyComment = async function(tileId, commentId) {
  try {
    await fetch('/api/tiles/' + tileId + '/comments/' + commentId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'applied' })
    });
  } catch (err) {
    showToast('Failed to apply comment');
  }
};

window.removeComment = async function(tileId, commentId) {
  try {
    await fetch('/api/tiles/' + tileId + '/comments/' + commentId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'removed' })
    });
  } catch (err) {
    showToast('Failed to remove comment');
  }
};

/* -- Expand tile fullscreen -- */
window.expandTile = function(slideId, tileId) {
  const targetId = 'rt-' + tileId;
  const target = document.getElementById(targetId);
  if (!target) return;
  const ws = state.workshop;
  if (!ws) return;
  const slide = ws.slides.find(s => s.id === slideId);
  if (!slide) return;
  const tile = slide.tiles.find(t => t.id === tileId);
  if (!tile) return;
  const isDiagram = tile.type === 'mermaid' || tile.type === 'kroki' || tile.type === 'svg';

  if (isDiagram) {
    const svg = target.querySelector('svg');
    fsInnerEl.innerHTML = '';
    if (svg) {
      const clone = svg.cloneNode(true);
      clone.removeAttribute('width'); clone.removeAttribute('height');
      clone.style.maxWidth = 'none'; clone.style.maxHeight = 'none';
      clone.style.width = 'auto'; clone.style.height = 'auto';
      fsInnerEl.appendChild(clone);
    } else {
      fsInnerEl.innerHTML = target.innerHTML;
    }
    Object.assign(fsState, makeZoomState());
    fullscreenEl.classList.add('active');
    fitDiagramToViewport(fsViewportEl, fsInnerEl, fsState);
  } else {
    fsInnerEl.innerHTML = '<div style="background:var(--bg-card);border-radius:var(--radius);padding:24px;max-width:95vw;max-height:95vh;overflow:auto;">' + target.innerHTML + '</div>';
    Object.assign(fsState, makeZoomState());
    applyTransform(fsInnerEl, fsState);
    fullscreenEl.classList.add('active');
  }
};

/* -- Finalize modal -- */
window.openFinalizeModal = function() {
  document.getElementById('finalize-modal').classList.add('active');
};
window.closeFinalizeModal = function() {
  document.getElementById('finalize-modal').classList.remove('active');
};
window.doFinalize = async function() {
  const outputDir = document.getElementById('finalize-dir').value.trim();
  const slug = document.getElementById('finalize-slug').value.trim();
  if (!outputDir || !slug) { showToast('Please fill in both fields'); return; }
  closeFinalizeModal();
  try {
    const res = await fetch('/api/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ output_dir: outputDir, slug: slug })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Workshop finalized: ' + data.path);
    } else {
      showToast('Finalize failed: ' + (data.error || 'unknown'));
    }
  } catch (err) {
    showToast('Finalize request failed');
  }
};

/* -- Pending-load modal -- */
function renderPendingLoadModal() {
  const modal = document.getElementById('pending-load-modal');
  const body = document.getElementById('pending-load-body');
  const pl = state.pendingLoad;
  if (pl) {
    const c = pl.current, r = pl.requested;
    body.innerHTML =
      'The agent has requested to load a new workshop into this session.<br><br>' +
      '<div style="padding:10px;background:var(--bg-card);border-radius:6px;margin-bottom:10px;">' +
        '<div style="color:var(--text);font-weight:600;margin-bottom:4px;">Currently loaded</div>' +
        '<div>' + escapeHtml(c.title) + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">' +
          c.slideCount + ' slide' + (c.slideCount !== 1 ? 's' : '') + ' &middot; ' +
          c.commentCount + ' comment' + (c.commentCount !== 1 ? 's' : '') + ' &middot; ' +
          c.chatCount + ' chat message' + (c.chatCount !== 1 ? 's' : '') +
        '</div>' +
      '</div>' +
      '<div style="padding:10px;background:var(--bg-card);border-radius:6px;margin-bottom:10px;border:1px solid var(--accent);">' +
        '<div style="color:var(--accent);font-weight:600;margin-bottom:4px;">Requested</div>' +
        '<div>' + escapeHtml(r.title) + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">' +
          r.slideCount + ' slide' + (r.slideCount !== 1 ? 's' : '') +
        '</div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--orange);">Accepting will discard the current workshop from this session. The YAML file on disk is not deleted.</div>';
    modal.classList.add('active');
  } else {
    modal.classList.remove('active');
  }
}

window.acceptPendingLoad = async function() {
  try {
    const res = await fetch('/api/workshop/load/confirm', { method: 'POST' });
    const data = await res.json();
    if (data.ok) showToast('Loaded new workshop');
    else showToast('Load confirm failed: ' + (data.error || 'unknown'));
  } catch {
    showToast('Load confirm request failed');
  }
};

window.declinePendingLoad = async function() {
  try {
    const res = await fetch('/api/workshop/load/cancel', { method: 'POST' });
    const data = await res.json();
    if (data.ok) showToast('Kept current workshop');
    else showToast('Load cancel failed: ' + (data.error || 'unknown'));
  } catch {
    showToast('Load cancel request failed');
  }
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeFullscreen();
    closeFinalizeModal();
  }
});

hydrate();
</script>
</body>
</html>`;

// --- Server ---

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // Serve UI
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(HTML_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
      });
    }

    // SSE
    if (url.pathname === "/api/events") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          sseClients.add(c);
        },
        cancel() {
          sseClients.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders(),
        },
      });
    }

    // Health
    if (url.pathname === "/api/health") {
      return jsonResponse({
        status: "ok",
        workshopId: workshop.id,
        title: workshop.title,
        slides: workshop.slides.length,
        chatMessages: workshop.chat.length,
        inboxEvents: inbox.length,
        currentSourcePath,
        hasPendingLoad: pendingLoad !== null,
      });
    }

    // GET workshop
    if (url.pathname === "/api/workshop" && req.method === "GET") {
      return jsonResponse(workshop);
    }

    // POST workshop/load — Load from YAML file.
    // Auto-restores from .live.yaml if present and workshop ID matches (survives agent compaction).
    // If a different workshop is currently loaded, returns 409 with a pending-load flag until the user confirms.
    if (url.pathname === "/api/workshop/load" && req.method === "POST") {
      return (async () => {
        let body: { path: string; force?: boolean };
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
        }
        if (!body.path) {
          return jsonResponse({ ok: false, error: "Missing 'path' field" }, 400);
        }
        try {
          const sourcePath = body.path.startsWith("/")
            ? body.path
            : `${process.cwd()}/${body.path}`;

          const sourceText = await Bun.file(sourcePath).text();
          const sourceParsed = yamlParse(sourceText) as Record<string, unknown>;
          const sourceId = (sourceParsed.id as string) || "";

          let toLoad: Record<string, unknown> = sourceParsed;
          let restoredFromLive = false;

          const livePath = livePathFor(sourcePath);
          const liveFile = Bun.file(livePath);
          if (await liveFile.exists()) {
            try {
              const liveText = await liveFile.text();
              const liveParsed = yamlParse(liveText) as Record<string, unknown>;
              if ((liveParsed.id as string) === sourceId) {
                toLoad = liveParsed;
                restoredFromLive = true;
              }
            } catch (err) {
              console.error("Failed to read live state, falling back to source:", err);
            }
          }

          const hasActiveWorkshop =
            currentSourcePath !== null ||
            workshop.slides.length > 0 ||
            workshop.chat.length > 0;
          const loadingDifferentWorkshop =
            hasActiveWorkshop && workshop.id !== sourceId;

          if (loadingDifferentWorkshop && !body.force) {
            pendingLoad = {
              sourcePath,
              parsedData: toLoad,
              requestedAt: new Date().toISOString(),
            };
            broadcastState();
            return jsonResponse(
              {
                ok: false,
                pending: true,
                reason:
                  "A different workshop is currently loaded. Waiting for browser confirmation.",
                summary: pendingLoadSummary(),
              },
              409,
            );
          }

          applyWorkshopFromParsed(toLoad);
          currentSourcePath = sourcePath;
          pendingLoad = null;
          broadcastState();
          return jsonResponse({ ok: true, id: workshop.id, restoredFromLive });
        } catch (err: any) {
          return jsonResponse({ ok: false, error: err.message }, 500);
        }
      })();
    }

    // POST workshop/load/confirm — Accept a pending load (user clicked Accept in browser)
    if (url.pathname === "/api/workshop/load/confirm" && req.method === "POST") {
      if (!pendingLoad) {
        return jsonResponse({ ok: false, error: "No pending load" }, 400);
      }
      applyWorkshopFromParsed(pendingLoad.parsedData);
      currentSourcePath = pendingLoad.sourcePath;
      pendingLoad = null;
      broadcastState();
      return jsonResponse({ ok: true, id: workshop.id });
    }

    // POST workshop/load/cancel — Decline a pending load (user clicked Decline in browser)
    if (url.pathname === "/api/workshop/load/cancel" && req.method === "POST") {
      if (!pendingLoad) {
        return jsonResponse({ ok: false, error: "No pending load" }, 400);
      }
      pendingLoad = null;
      broadcastState();
      return jsonResponse({ ok: true });
    }

    // POST /api/slides — Push new slide
    if (url.pathname === "/api/slides" && req.method === "POST") {
      return (async () => {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
        }
        const slide: Slide = {
          id: body.id || generateId(),
          title: body.title || "Untitled Slide",
          order: body.order ?? workshop.slides.length + 1,
          tiles: (body.tiles || []).map((t: any) => ({
            id: t.id || generateId(),
            type: t.type || "markdown",
            title: t.title || undefined,
            content: t.content || "",
            size: t.size || "full",
            comments: [],
            krokiDiagramType: t.krokiDiagramType || undefined,
            krokiOutputFormat: t.krokiOutputFormat || undefined,
          })),
        };
        workshop.slides.push(slide);
        broadcastState();
        return jsonResponse({ ok: true, id: slide.id });
      })();
    }

    // PUT /api/slides/:id — Update slide
    const slideUpdateMatch = url.pathname.match(/^\/api\/slides\/([^/]+)$/);
    if (slideUpdateMatch && req.method === "PUT") {
      return (async () => {
        const slideId = slideUpdateMatch[1];
        const slide = workshop.slides.find((s) => s.id === slideId);
        if (!slide) return jsonResponse({ ok: false, error: "Slide not found" }, 404);
        let body: any;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
        }
        if (body.title !== undefined) slide.title = body.title;
        if (body.order !== undefined) slide.order = body.order;
        if (body.tiles !== undefined) {
          slide.tiles = body.tiles.map((t: any) => ({
            id: t.id || generateId(),
            type: t.type || "markdown",
            title: t.title || undefined,
            content: t.content || "",
            size: t.size || "full",
            comments: t.comments || [],
            krokiDiagramType: t.krokiDiagramType || undefined,
            krokiOutputFormat: t.krokiOutputFormat || undefined,
          }));
        }
        broadcastState();
        return jsonResponse({ ok: true, id: slide.id });
      })();
    }

    // DELETE /api/slides/:id — Remove slide
    if (slideUpdateMatch && req.method === "DELETE") {
      const slideId = slideUpdateMatch[1];
      const idx = workshop.slides.findIndex((s) => s.id === slideId);
      if (idx === -1) return jsonResponse({ ok: false, error: "Slide not found" }, 404);
      workshop.slides.splice(idx, 1);
      broadcastState();
      return jsonResponse({ ok: true });
    }

    // POST /api/slides/:slideId/tiles — Add tile to slide
    const tileAddMatch = url.pathname.match(/^\/api\/slides\/([^/]+)\/tiles$/);
    if (tileAddMatch && req.method === "POST") {
      return (async () => {
        const slideId = tileAddMatch[1];
        const slide = workshop.slides.find((s) => s.id === slideId);
        if (!slide) return jsonResponse({ ok: false, error: "Slide not found" }, 404);
        let body: any;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
        }
        const tile: Tile = {
          id: body.id || generateId(),
          type: body.type || "markdown",
          title: body.title || undefined,
          content: body.content || "",
          size: body.size || "full",
          comments: [],
          krokiDiagramType: body.krokiDiagramType || undefined,
          krokiOutputFormat: body.krokiOutputFormat || undefined,
        };
        slide.tiles.push(tile);
        broadcastState();
        return jsonResponse({ ok: true, id: tile.id });
      })();
    }

    // PUT /api/slides/:slideId/tiles/:tileId — Update tile
    const tileUpdateMatch = url.pathname.match(/^\/api\/slides\/([^/]+)\/tiles\/([^/]+)$/);
    if (tileUpdateMatch && req.method === "PUT") {
      return (async () => {
        const slideId = tileUpdateMatch[1];
        const tileId = tileUpdateMatch[2];
        const slide = workshop.slides.find((s) => s.id === slideId);
        if (!slide) return jsonResponse({ ok: false, error: "Slide not found" }, 404);
        const tile = slide.tiles.find((t) => t.id === tileId);
        if (!tile) return jsonResponse({ ok: false, error: "Tile not found" }, 404);
        let body: any;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
        }
        if (body.type !== undefined) tile.type = body.type;
        if (body.title !== undefined) tile.title = body.title;
        if (body.content !== undefined) tile.content = body.content;
        if (body.size !== undefined) tile.size = body.size;
        if (body.krokiDiagramType !== undefined) tile.krokiDiagramType = body.krokiDiagramType;
        if (body.krokiOutputFormat !== undefined) tile.krokiOutputFormat = body.krokiOutputFormat;
        broadcastState();
        return jsonResponse({ ok: true, id: tile.id });
      })();
    }

    // POST /api/chat — Post chat message
    if (url.pathname === "/api/chat" && req.method === "POST") {
      return (async () => {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
        }
        const msg: ChatMessage = {
          id: generateId(),
          author: body.author || "user",
          content: body.content || "",
          createdAt: new Date().toISOString(),
        };
        workshop.chat.push(msg);
        // Auto-create inbox event for user messages
        if (msg.author === "user") {
          addInboxEvent("chat-message", { messageId: msg.id, content: msg.content });
        }
        broadcastState();
        return jsonResponse({ ok: true, id: msg.id });
      })();
    }

    // GET /api/chat — Get chat history
    if (url.pathname === "/api/chat" && req.method === "GET") {
      return jsonResponse(workshop.chat);
    }

    // POST /api/tiles/:tileId/comments — Add comment
    const commentAddMatch = url.pathname.match(/^\/api\/tiles\/([^/]+)\/comments$/);
    if (commentAddMatch && req.method === "POST") {
      return (async () => {
        const tileId = commentAddMatch[1];
        const tile = findTileById(tileId);
        if (!tile) return jsonResponse({ ok: false, error: "Tile not found" }, 404);
        let body: any;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
        }
        const comment: Comment = {
          id: generateId(),
          author: body.author || "user",
          content: body.content || "",
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        tile.comments.push(comment);
        broadcastState();
        return jsonResponse({ ok: true, id: comment.id });
      })();
    }

    // PUT /api/tiles/:tileId/comments/:commentId — Update comment
    const commentUpdateMatch = url.pathname.match(/^\/api\/tiles\/([^/]+)\/comments\/([^/]+)$/);
    if (commentUpdateMatch && req.method === "PUT") {
      return (async () => {
        const tileId = commentUpdateMatch[1];
        const commentId = commentUpdateMatch[2];
        const tile = findTileById(tileId);
        if (!tile) return jsonResponse({ ok: false, error: "Tile not found" }, 404);
        const comment = tile.comments.find((c) => c.id === commentId);
        if (!comment) return jsonResponse({ ok: false, error: "Comment not found" }, 404);
        let body: any;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
        }
        const oldStatus = comment.status;
        if (body.content !== undefined) comment.content = body.content;
        if (body.status !== undefined) {
          comment.status = body.status;
          if (body.status === "applied" && oldStatus !== "applied") {
            comment.appliedAt = new Date().toISOString();
            addInboxEvent("comment-applied", {
              tileId,
              commentId,
              content: comment.content,
            });
          }
        }
        broadcastState();
        return jsonResponse({ ok: true, id: comment.id });
      })();
    }

    // GET /api/inbox — Poll inbox
    if (url.pathname === "/api/inbox" && req.method === "GET") {
      const unconsumed = url.searchParams.get("unconsumed");
      if (unconsumed === "true") {
        return jsonResponse(inbox.filter((e) => !e.consumed));
      }
      return jsonResponse(inbox);
    }

    // POST /api/inbox/:id/consume — Mark event consumed
    const inboxConsumeMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/consume$/);
    if (inboxConsumeMatch && req.method === "POST") {
      const eventId = inboxConsumeMatch[1];
      const evt = inbox.find((e) => e.id === eventId);
      if (!evt) return jsonResponse({ ok: false, error: "Event not found" }, 404);
      evt.consumed = true;
      evt.consumedAt = new Date().toISOString();
      return jsonResponse({ ok: true });
    }

    // POST /api/finalize — Write workshop YAML to disk
    if (url.pathname === "/api/finalize" && req.method === "POST") {
      return (async () => {
        let body: any;
        try {
          body = await req.json();
        } catch {
          return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
        }
        const outputDir = body.output_dir || "docs/workshops";
        const slug = body.slug || "workshop";
        const date = new Date().toISOString().slice(0, 10);
        const filename = `${date}-${slug}.workshop.yaml`;
        const dirPath = outputDir.startsWith("/") ? outputDir : `${process.cwd()}/${outputDir}`;
        const filePath = `${dirPath}/${filename}`;

        try {
          // Ensure directory exists
          const { mkdirSync } = await import("fs");
          mkdirSync(dirPath, { recursive: true });

          // Serialize workshop to YAML
          const yamlContent = yamlSerialize({
            id: workshop.id,
            title: workshop.title,
            description: workshop.description,
            status: "finalized",
            created: workshop.created,
            finalized: new Date().toISOString(),
            slides: workshop.slides.map((s) => ({
              id: s.id,
              title: s.title,
              order: s.order,
              tiles: s.tiles.map((t) => ({
                id: t.id,
                type: t.type,
                title: t.title,
                content: t.content,
                size: t.size,
                comments: t.comments.map((c) => ({
                  id: c.id,
                  author: c.author,
                  content: c.content,
                  status: c.status,
                  createdAt: c.createdAt,
                  appliedAt: c.appliedAt,
                })),
                krokiDiagramType: t.krokiDiagramType,
                krokiOutputFormat: t.krokiOutputFormat,
              })),
            })),
            chat: workshop.chat.map((m) => ({
              id: m.id,
              author: m.author,
              content: m.content,
              createdAt: m.createdAt,
            })),
          });

          await Bun.write(filePath, yamlContent);
          workshop.status = "finalized";

          // Remove the live sidecar — the finalized YAML is the source of truth now.
          // Clear currentSourcePath and cancel any pending persist so the deletion isn't undone
          // by a trailing debounced write from earlier mutations.
          if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
          }
          if (currentSourcePath) {
            const livePath = livePathFor(currentSourcePath);
            try {
              const { unlinkSync, existsSync } = await import("fs");
              if (existsSync(livePath)) unlinkSync(livePath);
            } catch (err) {
              console.error("Failed to remove live sidecar on finalize:", err);
            }
            currentSourcePath = null;
          }

          // Auto-create inbox event
          addInboxEvent("finalize-requested", { path: filePath, slug });

          broadcastState();
          return jsonResponse({ ok: true, path: filePath });
        } catch (err: any) {
          return jsonResponse({ ok: false, error: err.message }, 500);
        }
      })();
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
});

function findTileById(tileId: string): Tile | undefined {
  for (const slide of workshop.slides) {
    const tile = slide.tiles.find((t) => t.id === tileId);
    if (tile) return tile;
  }
  return undefined;
}

console.log(`Agent Workshop server running at http://${HOST}:${PORT}`);
console.log(`  http://127.0.0.1:${PORT}  (localhost)`);
