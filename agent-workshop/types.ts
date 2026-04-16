// Agent Workshop — TypeScript type definitions
// Single source of truth for the data model. Imported by server.ts.

// --- Status and type enums (literal unions) ---

export type WorkshopStatus = "preparing" | "ready" | "active" | "finalized";

export type TileType = "markdown" | "mermaid" | "kroki" | "html" | "svg";

export type CommentStatus = "pending" | "applied" | "removed";

export type InboxEventType =
  | "comment-applied"
  | "chat-message"
  | "finalize-requested";

// --- Core data model ---

export interface Comment {
  id: string;
  author: "user" | "agent";
  content: string;
  status: CommentStatus;
  createdAt: string;
  appliedAt?: string;
}

export interface Tile {
  id: string;
  type: TileType;
  title?: string;
  content: string;
  size: "full" | "half";
  comments: Comment[];
  krokiDiagramType?: string;
  krokiOutputFormat?: string;
}

export interface Slide {
  id: string;
  title: string;
  order: number;
  tiles: Tile[];
}

export interface ChatMessage {
  id: string;
  author: "user" | "agent";
  content: string;
  createdAt: string;
}

export interface Workshop {
  id: string;
  title: string;
  description?: string;
  status: WorkshopStatus;
  created: string;
  slides: Slide[];
  chat: ChatMessage[];
}

// --- Inbox ---

export interface InboxEvent {
  id: string;
  type: InboxEventType;
  payload: Record<string, unknown>;
  createdAt: string;
  consumed: boolean;
  consumedAt?: string;
}
