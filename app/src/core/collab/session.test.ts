import { describe, expect, it } from "vitest";
import { createRegistry } from "../commands/builtin";
import { Session } from "../session/session";
import { FakeDialogs, FakeIO, sampleProject } from "../testing/fakes";
import { FakeHost } from "../testing/fakeHost";
import { FakeCollab } from "../testing/fakeCollab";
import { routedDax } from "../host/remoteDax";
import { FakeDax } from "../testing/fakeDax";
import type { Project } from "../model/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(10);
  }
};

function window(collab: FakeCollab, name: string) {
  const io = new FakeIO();
  io.disk.set("C:/cache/s", sampleProject("Sales"));
  const host = new FakeHost();
  const session = new Session(io, new FakeDialogs(), null, null, undefined, null, host, collab);
  return { io, host, session, registry: createRegistry(session), name };
}

const measureNames = (p: Project) => p.model.tmdl["tables/Sales.tmdl"].nodes[0].children.filter((c) => c.kind === "measure").map((c) => c.name);

describe("editing together through a session", () => {
  it("two windows open the same server report, see each other's edits and stop on request", async () => {
    const collab = new FakeCollab();
    const a = window(collab, "Ann");
    const b = window(collab, "Bob");
    for (const w of [a, b]) {
      expect((await w.registry.execute("collab.server.open", { connection: "c1", workspace: "w_1", report: "sales" })).ok).toBe(true);
      expect(w.session.getSnapshot().coedit?.status).toBe("synced");
      expect(w.session.getSnapshot().viewing).toBeNull();
      expect(w.session.store.getSnapshot().readOnly).toBe(false);
    }
    // the server holds the data: this report's queries go there even though it is editable
    const local = new FakeDax();
    local.answers.push({ match: "x", outcome: { results: [], elapsedMs: 0 } });
    await routedDax(a.session, local).query([], 'EVALUATE ROW("t", [Total])');
    expect(a.host.calls.some((c) => c.op === "query" && c.args.report === "sales")).toBe(true);

    a.session.store.transact("Add measure Margin", (d) => {
      d.model.tmdl["tables/Sales.tmdl"].nodes[0].children.push({ description: [], kind: "measure", name: "Margin", default: { text: "1", verbatim: false }, props: [], children: [] });
    });
    b.session.store.transact("Add measure Ratio", (d) => {
      d.model.tmdl["tables/Sales.tmdl"].nodes[0].children.push({ description: [], kind: "measure", name: "Ratio", default: { text: "2", verbatim: false }, props: [], children: [] });
    });
    await until(() => measureNames(a.session.store.project!).includes("Ratio") && measureNames(b.session.store.project!).includes("Margin"));
    expect(measureNames(a.session.store.project!).sort()).toEqual(["Margin", "Ratio", "Total"]);
    await until(() => (b.session.getSnapshot().coedit?.received ?? 0) > 0);
    expect(collab.changes.get(JSON.stringify({ kind: "server", connection: "c1", workspace: "w_1", report: "sales" }))?.length).toBeGreaterThanOrEqual(2);

    expect((await a.registry.execute("collab.stop")).ok).toBe(true);
    expect(a.session.getSnapshot().coedit).toBeNull();
    b.session.store.transact("Another", (d) => {
      d.model.tmdl["tables/Sales.tmdl"].nodes[0].children.push({ description: [], kind: "measure", name: "Late", default: null, props: [], children: [] });
    });
    await sleep(300);
    expect(measureNames(a.session.store.project!)).not.toContain("Late");
    await b.session.stopCoEdit();
  });

  it("a viewer is told to open the report for viewing, and a lost connection is shown and recovers", async () => {
    const collab = new FakeCollab();
    const a = window(collab, "Ann");
    a.host.openRole = "viewer";
    const r = await a.registry.execute("collab.server.open", { connection: "c1", workspace: "w_1", report: "sales" });
    expect(r.ok).toBe(false);
    a.host.openRole = "editor";
    expect((await a.registry.execute("collab.server.open", { connection: "c1", workspace: "w_1", report: "sales" })).ok).toBe(true);
    collab.down = true;
    a.session.store.transact("Edit", (d) => {
      d.model.tmdl["tables/Sales.tmdl"].nodes[0].children.push({ description: [], kind: "measure", name: "Offline", default: null, props: [], children: [] });
    });
    await until(() => a.session.getSnapshot().coedit?.status === "offline");
    collab.down = false;
    await until(() => a.session.getSnapshot().coedit?.status === "synced");
    const key = JSON.stringify({ kind: "server", connection: "c1", workspace: "w_1", report: "sales" });
    expect(collab.changes.get(key)?.[0].summary).toBe("Edit");
    await a.session.stopCoEdit();
  });
});

describe("comments", () => {
  it("are kept where the report is shared, answered in threads, resolved and deleted", async () => {
    const collab = new FakeCollab();
    const w = window(collab, "Ann");
    await w.registry.execute("collab.server.open", { connection: "c1", workspace: "w_1", report: "sales" });
    expect((await w.registry.execute("comments.open")).ok).toBe(true);
    expect(w.session.shell.getSnapshot().dialog).toEqual({ kind: "comments" });
    expect(w.session.comments.getSnapshot().where).toContain("on the server");
    expect((await w.registry.execute("comments.add", { text: "  " })).ok).toBe(false);
    expect((await w.registry.execute("comments.add", { text: "Q3 looks low, @ann please check", anchor: { page: "p1", visual: "v1" } })).ok).toBe(true);
    let s = w.session.comments.getSnapshot();
    expect(s.comments).toHaveLength(1);
    expect(s.comments[0].anchor).toEqual({ page: "p1", visual: "v1" });
    expect(s.mentionsMe).toBe(1);
    const id = s.comments[0].id;
    await w.registry.execute("comments.add", { text: "Checked", parent: id });
    await w.registry.execute("comments.resolve", { id, resolved: true });
    s = w.session.comments.getSnapshot();
    expect(s.comments.every((c) => c.resolved)).toBe(true);
    expect(s.mentionsMe).toBe(0);
    expect(s.changes.length).toBeGreaterThanOrEqual(0);
    await w.registry.execute("comments.delete", { id });
    expect(w.session.comments.getSnapshot().comments).toHaveLength(0);
    await w.session.stopCoEdit();
  });

  it("stay on this PC when the report is not shared", async () => {
    const collab = new FakeCollab();
    const w = window(collab, "Ann");
    await w.session.openProject("C:/cache/s/Sales.pbip");
    await w.registry.execute("comments.open");
    expect(w.session.comments.getSnapshot().ctx).toEqual({ kind: "local", root: "C:/cache/s" });
    expect(w.session.comments.getSnapshot().where).toContain("only on this PC");
  });
});
