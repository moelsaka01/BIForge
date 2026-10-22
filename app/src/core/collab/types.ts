// What the co-editing and comment code needs from the app backend (app/src-tauri/src/collab.rs).

/** Who carries the shared document and the comments. */
export type CollabContext =
  | { kind: "server"; connection: string; workspace: string; report: string }
  | { kind: "p2pHost"; target: string }
  | { kind: "p2pGuest"; guest: string }
  /** Comments kept on this PC next to the project. */
  | { kind: "local"; root: string };

export interface CollabAnswer {
  meta: unknown;
  blob: Uint8Array;
}

export interface CollabApi {
  call(ctx: CollabContext, op: string, args: Record<string, unknown>, blob?: Uint8Array): Promise<CollabAnswer>;
}

export interface CommentAnchor {
  page?: string | null;
  visual?: string | null;
}

export interface Comment {
  id: string;
  parent: string | null;
  author: string;
  identity: string;
  text: string;
  anchor: CommentAnchor;
  mentions: string[];
  createdAt: string;
  resolved: boolean;
  resolvedBy: string | null;
}

export interface ChangeEntry {
  time: string;
  actor: string;
  summary: string;
}

/** The co-editing session of the open project, as the status bar and dialogs show it. */
export interface CoEditInfo {
  ctx: CollabContext;
  label: string;
  status: "starting" | "synced" | "sending" | "offline" | "stopped";
  detail: string | null;
  /** Number of times changes of others arrived. */
  received: number;
  /** Set when the queries of this report go to a server (it holds the data). */
  server?: { connectionId: string; workspaceId: string; reportId: string };
}
