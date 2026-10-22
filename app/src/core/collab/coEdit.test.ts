import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocumentStore } from "../store/documentStore";
import type { Project } from "../model/types";
import { CoEditSession, type CollabTransport, type SyncReply, type SyncRequest } from "./coEdit";

/** What the server (or the host of a direct session) does with the updates: merge them, seed only an empty document. */
class Relay implements CollabTransport {
  doc = new Y.Doc();
  down = false;
  log: string[] = [];
  async sync(req: SyncRequest): Promise<SyncReply> {
    if (this.down) throw new Error("network is down");
    const empty = () => Y.encodeStateVector(this.doc).length <= 1;
    let seeded = false;
    if (req.update.length) {
      if (req.seed) {
        if (empty()) {
          Y.applyUpdate(this.doc, req.update);
          seeded = true;
        }
      } else Y.applyUpdate(this.doc, req.update);
      if (!req.seed || seeded) this.log.push(req.summary);
    }
    return { update: Y.encodeStateAsUpdate(this.doc, req.stateVector.length ? req.stateVector : undefined), stateVector: Y.encodeStateVector(this.doc), seeded, empty: empty() };
  }
}

const node = (kind: string, name: string) => ({ description: [], kind, name, default: null, props: [], children: [] });

function project(): Project {
  return {
    name: "Demo",
    pbip: {},
    report_dir: "C:/a/Demo.Report",
    model_dir: "C:/a/Demo.SemanticModel",
    model: { pbism: {}, platform: null, tmdl: { "t.tmdl": { nodes: [node("table", "Sales")] } } },
    report: { pbir: {}, platform: null, files: { "v1.json": { name: "v1", x: 0 }, "v2.json": { name: "v2", x: 0 } } },
  } as unknown as Project;
}

const files = (s: DocumentStore) => s.project!.report.files as Record<string, { x: number; title?: string }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
};

async function person(relay: Relay, p: Project) {
  const store = new DocumentStore();
  store.load(structuredClone(p));
  const co = new CoEditSession(store, relay, { pollMs: 20, debounceMs: 5 });
  return { store, co };
}

describe("co-editing session", () => {
  it("the first person seeds, the second starts from the shared state, and edits flow both ways", async () => {
    const relay = new Relay();
    const ann = await person(relay, project());
    await ann.co.start();
    // Bob opens an older copy of the project: he gets the shared state instead
    const old = project();
    (old.report.files as Record<string, { x: number }>)["v1.json"].x = 999;
    const bob = await person(relay, old);
    await bob.co.start();
    expect(files(bob.store)["v1.json"].x).toBe(0);
    expect(bob.store.project!.report_dir).toBe("C:/a/Demo.Report");

    ann.store.transact("Move v1", (d) => ((d.report.files as Record<string, { x: number }>)["v1.json"].x = 10));
    bob.store.transact("Move v2", (d) => ((d.report.files as Record<string, { x: number }>)["v2.json"].x = 20));
    await until(() => files(ann.store)["v2.json"].x === 20 && files(bob.store)["v1.json"].x === 10);
    expect(relay.log.filter((l) => l.startsWith("Move")).sort()).toEqual(["Move v1", "Move v2"]);
    await ann.co.stop();
    await bob.co.stop();
  });

  it("two people who both seed at once end up with one document, not two", async () => {
    const relay = new Relay();
    const a = await person(relay, project());
    const b = await person(relay, project());
    await Promise.all([a.co.start(), b.co.start()]);
    expect(Object.keys(files(a.store)).sort()).toEqual(["v1.json", "v2.json"]);
    expect(Object.keys(files(b.store)).sort()).toEqual(["v1.json", "v2.json"]);
    expect(a.store.project!.model.tmdl["t.tmdl"].nodes).toHaveLength(1);
    await a.co.stop();
    await b.co.stop();
  });

  it("edits made while offline are sent later, and the remote change ends the undo history", async () => {
    const relay = new Relay();
    const a = await person(relay, project());
    const b = await person(relay, project());
    await a.co.start();
    await b.co.start();
    relay.down = true;
    a.store.transact("Rename v1", (d) => ((d.report.files as Record<string, { x: number; title?: string }>)["v1.json"].title = "Offline edit"));
    await until(() => a.co.status === "offline");
    expect(files(b.store)["v1.json"].title).toBeUndefined();
    relay.down = false;
    await until(() => files(b.store)["v1.json"].title === "Offline edit");
    expect(b.store.getSnapshot().canUndo).toBe(false);
    expect(a.store.getSnapshot().canUndo).toBe(true);
    // undo is also an edit that others receive
    a.store.undo();
    await until(() => files(b.store)["v1.json"].title === undefined);
    await a.co.stop();
    await b.co.stop();
  });

  it("stopping sends the last edits first and the session stops listening", async () => {
    const relay = new Relay();
    const a = await person(relay, project());
    const b = await person(relay, project());
    await a.co.start();
    await b.co.start();
    a.store.transact("Last", (d) => ((d.report.files as Record<string, { x: number }>)["v1.json"].x = 7));
    await a.co.stop();
    await until(() => files(b.store)["v1.json"].x === 7);
    a.store.transact("After stop", (d) => ((d.report.files as Record<string, { x: number }>)["v1.json"].x = 8));
    await sleep(100);
    expect(files(b.store)["v1.json"].x).toBe(7);
    await b.co.stop();
  });
});
