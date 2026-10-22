// State and logic of the Comments dialog: the comments of the open report, the people who can be mentioned, and the
// recent changes made together. The comments live where the report is shared: on the server, with the host of a direct
// session, or (for a report that is not shared) next to the project on this PC only.

import type { Session } from "../session/session";
import type { ChangeEntry, CollabContext, Comment, CommentAnchor } from "./types";

export interface CommentsState {
  ctx: CollabContext | null;
  /** Where the comments are kept, in words, for the dialog. */
  where: string;
  comments: Comment[];
  changes: ChangeEntry[];
  /** Open comments by others that mention this person (server only). */
  mentionsMe: number;
  /** Names that can be mentioned (the members of the workspace, or the people in the session). */
  people: string[];
  busy: boolean;
  error: string | null;
}

const EMPTY: CommentsState = { ctx: null, where: "", comments: [], changes: [], mentionsMe: 0, people: [], busy: false, error: null };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class CommentsUi {
  private snap: CommentsState = EMPTY;
  private listeners = new Set<() => void>();
  constructor(private readonly session: Session) {}

  getSnapshot = (): CommentsState => this.snap;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<CommentsState>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** The place the open report's comments belong to. */
  context(): { ctx: CollabContext; where: string } | null {
    const s = this.session.getSnapshot();
    if (s.coedit) {
      const w = s.coedit.ctx.kind === "server" ? "on the server, visible to everyone in the workspace" : "in this direct session, visible to everyone in it";
      return { ctx: s.coedit.ctx, where: w };
    }
    if (s.viewing?.server) {
      const v = s.viewing.server;
      return { ctx: { kind: "server", connection: v.connectionId, workspace: v.workspaceId, report: v.reportId }, where: "on the server, visible to everyone in the workspace" };
    }
    if (s.viewing?.p2p) return { ctx: { kind: "p2pGuest", guest: s.viewing.p2p.guestId }, where: "in this direct session, visible to everyone in it" };
    if (s.root && !s.viewing) return { ctx: { kind: "local", root: s.root }, where: "only on this PC (this report is not shared; start co-editing or share it to comment together)" };
    return null;
  }

  private get api() {
    const c = this.session.collab;
    if (!c) throw new Error("Comments need the BIForge app window.");
    return c;
  }

  private async guard<T>(f: () => Promise<T>): Promise<T | undefined> {
    this.set({ busy: true, error: null });
    try {
      return await f();
    } catch (e) {
      this.set({ error: errText(e) });
      return undefined;
    } finally {
      this.set({ busy: false });
    }
  }

  async refresh(): Promise<void> {
    const c = this.context();
    if (!c) {
      this.set({ ...EMPTY });
      return;
    }
    await this.guard(async () => {
      const comments = ((await this.api.call(c.ctx, "comments.list", {})).meta as Comment[]) ?? [];
      let changes: ChangeEntry[] = [];
      try {
        changes = ((await this.api.call(c.ctx, "collab.changes", {})).meta as ChangeEntry[]) ?? [];
      } catch {
        /* a viewer of a direct session has no change list */
      }
      let mentionsMe = 0;
      try {
        mentionsMe = (((await this.api.call(c.ctx, "comments.mentions", {})).meta as unknown[]) ?? []).length;
      } catch {
        /* not available everywhere */
      }
      const people = await this.peopleOf(c.ctx);
      this.set({ ctx: c.ctx, where: c.where, comments, changes, mentionsMe, people });
    });
  }

  private async peopleOf(ctx: CollabContext): Promise<string[]> {
    if (ctx.kind === "server" && this.session.host) {
      try {
        const members = await this.session.host.op<{ name: string; identity: string; revoked: boolean }[]>(ctx.connection, "members", { workspace: ctx.workspace });
        return members.filter((m) => !m.revoked).map((m) => m.identity.split("@")[0]);
      } catch {
        /* only administrators may list the members */
      }
    }
    return [...new Set(this.snap.comments.map((c) => c.author.split(/\s+/)[0]))];
  }

  async add(text: string, anchor: CommentAnchor = {}, parent: string | null = null): Promise<void> {
    const ok = await this.guard(async () => {
      const c = this.context();
      if (!c) throw new Error("Open a report first.");
      if (!text.trim()) throw new Error("Write something first.");
      await this.api.call(c.ctx, "comments.add", { text, anchor, parent });
      return true;
    });
    if (ok) await this.refresh();
  }

  async resolve(id: string, resolved: boolean): Promise<void> {
    await this.guard(async () => {
      const c = this.context();
      if (!c) return;
      await this.api.call(c.ctx, "comments.resolve", { id, resolved });
    });
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    await this.guard(async () => {
      const c = this.context();
      if (!c) return;
      await this.api.call(c.ctx, "comments.delete", { id });
    });
    await this.refresh();
  }
}
