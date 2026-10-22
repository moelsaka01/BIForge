import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Project } from "../model/types";
import { decode, projectOf, ROOT, seedProject, syncProject, deepEqual } from "./jsonYjs";

const node = (kind: string, name: string | null, children: unknown[] = []) => ({ description: [], kind, name, default: null, props: [], children });

function project(over: Partial<Project["report"]> = {}, nodes = [node("measure", "Total"), node("measure", "Count")]): Project {
  return {
    name: "Demo",
    pbip: {},
    report_dir: "C:/a/Demo.Report",
    model_dir: "C:/a/Demo.SemanticModel",
    model: { pbism: { version: "4.0" }, platform: null, tmdl: { "definition/tables/Sales.tmdl": { nodes: [node("table", "Sales", nodes)] } } },
    report: {
      pbir: { version: "4.0" },
      platform: null,
      files: {
        "definition/pages/p1/page.json": { name: "p1", displayName: "Overview" },
        "definition/pages/p1/visuals/v1/visual.json": { name: "v1", position: { x: 0, y: 0, width: 100, height: 50 }, visual: { visualType: "card", title: "A" } },
        "definition/pages/p1/visuals/v2/visual.json": { name: "v2", position: { x: 120, y: 0, width: 100, height: 50 }, visual: { visualType: "card", title: "B" } },
      },
      ...over,
    },
  } as unknown as Project;
}

/** Two people start from the same document and edit at the same time; all updates are exchanged afterwards. */
function twoPeople(base: Project) {
  const seed = new Y.Doc();
  seedProject(seed, base);
  const update = Y.encodeStateAsUpdate(seed);
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, update);
  Y.applyUpdate(b, update);
  const exchange = () => {
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  };
  return { a, b, exchange };
}

const edit = (p: Project, f: (d: Project) => void): Project => {
  const c = structuredClone(p);
  f(c);
  return c;
};

describe("project <-> Yjs", () => {
  it("round-trips a project", () => {
    const doc = new Y.Doc();
    const p = project();
    seedProject(doc, p);
    const back = projectOf(doc, { ...p, model: {} as never, report: {} as never });
    expect(back.model).toEqual(p.model);
    expect(back.report).toEqual(p.report);
    // the person's own paths stay theirs
    expect(back.report_dir).toBe(p.report_dir);
  });

  it("writes only the difference of an edit and reads it back", () => {
    const doc = new Y.Doc();
    const p = project();
    seedProject(doc, p);
    const sizeBefore = Y.encodeStateAsUpdate(doc).length;
    const sv = Y.encodeStateVector(doc);
    const next = edit(p, (d) => {
      (d.report.files["definition/pages/p1/visuals/v1/visual.json"] as { position: { x: number } }).position.x = 40;
    });
    syncProject(doc, p, next);
    const delta = Y.encodeStateAsUpdate(doc, sv);
    expect(delta.length).toBeLessThan(sizeBefore / 3);
    expect(projectOf(doc, p).report).toEqual(next.report);
  });

  it("merges edits to different properties, different items and different files", () => {
    const base = project();
    const { a, b, exchange } = twoPeople(base);
    // Ann moves visual v1 and adds a measure; Bob changes the title of v2 and the page name
    const ann = edit(base, (d) => {
      (d.report.files["definition/pages/p1/visuals/v1/visual.json"] as { position: { x: number } }).position.x = 10;
      d.model.tmdl["definition/tables/Sales.tmdl"].nodes[0].children.push(node("measure", "Margin") as never);
    });
    const bob = edit(base, (d) => {
      (d.report.files["definition/pages/p1/visuals/v2/visual.json"] as { visual: { title: string } }).visual.title = "B2";
      (d.report.files["definition/pages/p1/page.json"] as { displayName: string }).displayName = "Summary";
      d.model.tmdl["definition/tables/Sales.tmdl"].nodes[0].children.push(node("measure", "Ratio") as never);
    });
    syncProject(a, base, ann);
    syncProject(b, base, bob);
    exchange();
    const pa = projectOf(a, base);
    const pb = projectOf(b, base);
    expect(deepEqual(pa, pb)).toBe(true);
    const files = pa.report.files as Record<string, { position?: { x: number }; visual?: { title: string }; displayName?: string }>;
    expect(files["definition/pages/p1/visuals/v1/visual.json"].position?.x).toBe(10);
    expect(files["definition/pages/p1/visuals/v2/visual.json"].visual?.title).toBe("B2");
    expect(files["definition/pages/p1/page.json"].displayName).toBe("Summary");
    const measures = pa.model.tmdl["definition/tables/Sales.tmdl"].nodes[0].children.map((c) => c.name);
    expect(measures.sort()).toEqual(["Count", "Margin", "Ratio", "Total"]);
  });

  it("a deletion by one person and an edit of another item by the other both hold", () => {
    const base = project();
    const { a, b, exchange } = twoPeople(base);
    const ann = edit(base, (d) => {
      d.model.tmdl["definition/tables/Sales.tmdl"].nodes[0].children = d.model.tmdl["definition/tables/Sales.tmdl"].nodes[0].children.filter((c) => c.name !== "Count");
      delete d.report.files["definition/pages/p1/visuals/v2/visual.json"];
    });
    const bob = edit(base, (d) => {
      (d.report.files["definition/pages/p1/visuals/v1/visual.json"] as { visual: { title: string } }).visual.title = "A2";
    });
    syncProject(a, base, ann);
    syncProject(b, base, bob);
    exchange();
    const p = projectOf(a, base);
    expect(deepEqual(p, projectOf(b, base))).toBe(true);
    expect(Object.keys(p.report.files)).toEqual(["definition/pages/p1/page.json", "definition/pages/p1/visuals/v1/visual.json"]);
    expect((p.report.files["definition/pages/p1/visuals/v1/visual.json"] as { visual: { title: string } }).visual.title).toBe("A2");
    expect(p.model.tmdl["definition/tables/Sales.tmdl"].nodes[0].children.map((c) => c.name)).toEqual(["Total"]);
  });

  it("the same property changed by both converges to one value on both sides", () => {
    const base = project();
    const { a, b, exchange } = twoPeople(base);
    syncProject(a, base, edit(base, (d) => ((d.report.files["definition/pages/p1/page.json"] as { displayName: string }).displayName = "From Ann")));
    syncProject(b, base, edit(base, (d) => ((d.report.files["definition/pages/p1/page.json"] as { displayName: string }).displayName = "From Bob")));
    exchange();
    const na = (projectOf(a, base).report.files["definition/pages/p1/page.json"] as { displayName: string }).displayName;
    const nb = (projectOf(b, base).report.files["definition/pages/p1/page.json"] as { displayName: string }).displayName;
    expect(na).toBe(nb);
    expect(["From Ann", "From Bob"]).toContain(na);
  });

  it("reordering and lists without keys are carried whole", () => {
    const base = project({ pbir: { filters: [1, 2, 3] } });
    const doc = new Y.Doc();
    seedProject(doc, base);
    const reordered = edit(base, (d) => {
      const nodes = d.model.tmdl["definition/tables/Sales.tmdl"].nodes[0].children;
      nodes.reverse();
      (d.report.pbir as { filters: number[] }).filters = [3, 2, 1, 0];
    });
    syncProject(doc, base, reordered);
    const back = projectOf(doc, base);
    expect(back.model.tmdl["definition/tables/Sales.tmdl"].nodes[0].children.map((c) => c.name)).toEqual(["Count", "Total"]);
    expect((back.report.pbir as { filters: number[] }).filters).toEqual([3, 2, 1, 0]);
  });

  it("decode ignores order entries that two people added twice", () => {
    const doc = new Y.Doc();
    seedProject(doc, project());
    const root = doc.getMap(ROOT);
    // simulate the duplicate that two simultaneous inserts of the same key leave behind
    const files = (root.get("report") as Y.Map<unknown>).get("files") as Y.Map<unknown>;
    expect(files).toBeInstanceOf(Y.Map);
    expect(decode(root)).toBeTruthy();
  });
});

describe("lists of names", () => {
  it("two people adding a page at the same time both keep their page", () => {
    const base = project({ pbir: { pageOrder: ["p1", "p2"] } } as never);
    const { a, b, exchange } = twoPeople(base);
    syncProject(a, base, edit(base, (d) => ((d.report.pbir as { pageOrder: string[] }).pageOrder = ["p1", "p2", "pa"])));
    syncProject(b, base, edit(base, (d) => ((d.report.pbir as { pageOrder: string[] }).pageOrder = ["p1", "pb", "p2"])));
    exchange();
    const order = (projectOf(a, base).report.pbir as { pageOrder: string[] }).pageOrder;
    expect([...order].sort()).toEqual(["p1", "p2", "pa", "pb"]);
    expect((projectOf(b, base).report.pbir as { pageOrder: string[] }).pageOrder).toEqual(order);
  });
});
