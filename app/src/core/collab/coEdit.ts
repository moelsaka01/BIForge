// Real-time co-editing of the open project. The project is mirrored in a Yjs document (jsonYjs.ts); what the person
// changes is written into it as a small update and sent through a transport (a BIForge server, or the host or a guest
// of a direct session); what others changed arrives the same way and replaces the project in the store.
//
// The transport has one operation, `sync`: send the updates made since the last call together with the state we
// have, and receive what we are missing. The first person to open a report seeds the shared document from the project;
// everybody else starts from the shared state (their own copy of the project is replaced by it).

import * as Y from "yjs";
import type { DocumentStore } from "../store/documentStore";
import { projectOf, REMOTE, seedProject, syncProject, LOCAL } from "./jsonYjs";

export interface SyncRequest {
  stateVector: Uint8Array;
  update: Uint8Array;
  seed: boolean;
  summary: string;
}
export interface SyncReply {
  update: Uint8Array;
  stateVector: Uint8Array;
  seeded: boolean;
  /** The shared document has no content yet. */
  empty: boolean;
}
export interface CollabTransport {
  sync(req: SyncRequest): Promise<SyncReply>;
}

export type CoEditStatus = "starting" | "synced" | "sending" | "offline" | "stopped";

export interface CoEditOptions {
  /** How often to ask for changes of others when there is nothing to send. */
  pollMs?: number;
  /** Wait this long after an edit before sending, so a burst of edits travels as one update. */
  debounceMs?: number;
  onStatus?: (s: CoEditStatus, detail: string | null) => void;
}

const EMPTY = new Uint8Array(0);

export class CoEditSession {
  private doc = new Y.Doc();
  private pending: Uint8Array[] = [];
  private labels: string[] = [];
  private off: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private remoteApplied = false;
  status: CoEditStatus = "starting";
  /** Updates that arrived from others (for the status line and tests). */
  received = 0;

  constructor(private readonly store: DocumentStore, private readonly transport: CollabTransport, private readonly opts: CoEditOptions = {}) {}

  private setStatus(s: CoEditStatus, detail: string | null = null): void {
    this.status = s;
    this.opts.onStatus?.(s, detail);
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Joins the shared document: starts from the shared state, or seeds it with this project when it is new. */
  async start(): Promise<void> {
    const project = this.store.project;
    if (!project) throw new Error("Open a project first.");
    await this.serial(async () => {
      const first = await this.transport.sync({ stateVector: EMPTY, update: EMPTY, seed: false, summary: "" });
      if (!first.empty) {
        this.adopt(first.update);
      } else {
        seedProject(this.doc, project);
        const seeded = await this.transport.sync({ stateVector: Y.encodeStateVector(this.doc), update: Y.encodeStateAsUpdate(this.doc), seed: true, summary: "Started co-editing" });
        if (!seeded.seeded) {
          // somebody else seeded at the same moment: take their state, drop ours
          this.doc = new Y.Doc();
          this.adopt(seeded.update);
        }
      }
    });
    this.watch();
    this.setStatus("synced");
    this.poller = setInterval(() => void this.pull(), this.opts.pollMs ?? 1500);
  }

  /** Replaces the project with the shared state. */
  private adopt(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, REMOTE);
    const own = this.store.project!;
    this.store.applyRemote(projectOf(this.doc, own));
  }

  private watch(): void {
    const onUpdate = (u: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) this.pending.push(u);
      if (origin === REMOTE) this.remoteApplied = true;
    };
    this.doc.on("update", onUpdate);
    const unsub = this.store.onProjectChange((prev, next, label) => {
      if (this.stopped) return;
      syncProject(this.doc, prev, next, LOCAL);
      if (label) this.labels.push(label);
      this.schedule();
    });
    this.off = () => {
      this.doc.off("update", onUpdate);
      unsub();
    };
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.opts.debounceMs ?? 150);
  }

  /** Sends what the person changed and receives what the others changed. */
  async flush(): Promise<void> {
    if (this.stopped) return;
    await this.serial(async () => {
      if (this.stopped) return;
      const sending = this.pending;
      const update = sending.length ? Y.mergeUpdates(sending) : EMPTY;
      const labels = this.labels;
      this.pending = [];
      this.labels = [];
      if (update.length) this.setStatus("sending");
      try {
        const reply = await this.transport.sync({ stateVector: Y.encodeStateVector(this.doc), update, seed: false, summary: this.summaryOf(labels) });
        this.receive(reply.update);
        this.setStatus("synced");
      } catch (e) {
        // keep what was not sent; the next round sends it again
        this.pending = [...sending, ...this.pending];
        this.labels = [...labels, ...this.labels];
        this.setStatus("offline", e instanceof Error ? e.message : String(e));
      }
    });
  }

  private summaryOf(labels: string[]): string {
    const uniq = [...new Set(labels)];
    return uniq.slice(0, 4).join("; ") + (uniq.length > 4 ? "; ..." : "");
  }

  private async pull(): Promise<void> {
    if (this.stopped) return;
    await this.flush();
  }

  private receive(update: Uint8Array): void {
    this.remoteApplied = false;
    Y.applyUpdate(this.doc, update, REMOTE);
    if (this.remoteApplied) {
      this.received++;
      this.store.applyRemote(projectOf(this.doc, this.store.project!));
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    // stop listening first, so the next document opened in this window is never written into this one
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poller) clearInterval(this.poller);
    this.off?.();
    await this.chain.catch(() => undefined);
    if (this.pending.length) {
      try {
        await this.transport.sync({ stateVector: Y.encodeStateVector(this.doc), update: Y.mergeUpdates(this.pending), seed: false, summary: this.summaryOf(this.labels) });
        this.pending = [];
      } catch {
        /* the last edits could not be sent; they stay in the file the person saves */
      }
    }
    this.setStatus("stopped");
  }

  /** The Yjs document (tests). */
  get document(): Y.Doc {
    return this.doc;
  }
}

