import * as Y from "yjs";
import type { CollabAnswer, CollabApi, CollabContext, Comment } from "../collab/types";

/** An in-memory stand-in for the backend: a shared Yjs document and a comment list per context. */
export class FakeCollab implements CollabApi {
  docs = new Map<string, Y.Doc>();
  comments = new Map<string, Comment[]>();
  changes = new Map<string, { time: string; actor: string; summary: string }[]>();
  calls: { ctx: CollabContext; op: string; args: Record<string, unknown> }[] = [];
  author = "Ann";
  down = false;

  private key(ctx: CollabContext): string {
    return JSON.stringify(ctx);
  }

  async call(ctx: CollabContext, op: string, args: Record<string, unknown>, blob?: Uint8Array): Promise<CollabAnswer> {
    this.calls.push({ ctx, op, args });
    if (this.down) throw new Error("network is down");
    const k = this.key(ctx);
    const none = new Uint8Array(0);
    if (op === "collab.sync") {
      const doc = this.docs.get(k) ?? new Y.Doc();
      this.docs.set(k, doc);
      const svLen = Number(args.svLen ?? 0);
      const sv = (blob ?? none).slice(0, svLen);
      const update = (blob ?? none).slice(svLen);
      const empty = () => Y.encodeStateVector(doc).length <= 1;
      let seeded = false;
      if (update.length) {
        if (args.seed) {
          if (empty()) {
            Y.applyUpdate(doc, update);
            seeded = true;
          }
        } else Y.applyUpdate(doc, update);
        if (!args.seed || seeded) this.changes.set(k, [{ time: "2026-10-22T10:00:00Z", actor: this.author, summary: String(args.summary || "changed the report") }, ...(this.changes.get(k) ?? [])]);
      }
      const svOut = Y.encodeStateVector(doc);
      const diff = Y.encodeStateAsUpdate(doc, sv.length ? sv : undefined);
      const out = new Uint8Array(svOut.length + diff.length);
      out.set(svOut, 0);
      out.set(diff, svOut.length);
      return { meta: { seeded, empty: empty(), svLen: svOut.length }, blob: out };
    }
    const list = this.comments.get(k) ?? [];
    this.comments.set(k, list);
    switch (op) {
      case "collab.changes":
        return { meta: this.changes.get(k) ?? [], blob: none };
      case "comments.list":
        return { meta: structuredClone(list), blob: none };
      case "comments.add": {
        const text = String(args.text ?? "").trim();
        if (!text) throw new Error("Write something first.");
        const parent = typeof args.parent === "string" ? args.parent : null;
        const c: Comment = {
          id: `c${list.length + 1}`,
          parent,
          author: this.author,
          identity: `${this.author.toLowerCase()}@x.com`,
          text,
          anchor: (args.anchor as Comment["anchor"]) ?? {},
          mentions: [...text.matchAll(/@([\w.]+)/g)].map((m) => `${m[1]}@x.com`),
          createdAt: "2026-10-22T10:00:00Z",
          resolved: false,
          resolvedBy: null,
        };
        list.push(c);
        return { meta: c, blob: none };
      }
      case "comments.resolve": {
        for (const c of list) if (c.id === args.id || c.parent === args.id) c.resolved = args.resolved !== false;
        return { meta: { ok: true }, blob: none };
      }
      case "comments.delete":
        this.comments.set(k, list.filter((c) => c.id !== args.id && c.parent !== args.id));
        return { meta: { ok: true }, blob: none };
      case "comments.mentions":
        return { meta: list.filter((c) => !c.resolved && c.mentions.includes(`${this.author.toLowerCase()}@x.com`)), blob: none };
    }
    throw new Error(`unknown op ${op}`);
  }
}
