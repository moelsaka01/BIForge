import { describe, expect, it } from "vitest";
import { READ_ONLY_MESSAGE, DocumentStore } from "../store/documentStore";
import { CommandRegistry } from "../commands/registry";
import { viewingGuard, VIEWING_MESSAGE } from "../commands/publishCommands";
import type { Session } from "../session/session";
import { fixtureProject } from "../report/testFixture";
import { allTables, listTables } from "../model/ops";
import { allGuides, freeTierLines, getGuide, guideForAdapter, GUIDE_FOR_ADAPTER } from "./guides";
import { pruneForPublishing, sameSelection } from "./prune";
import { defaultAdapters } from "../testing/fakePublish";

describe("read-only document store", () => {
  it("refuses every change, undo and redo until another document is loaded", () => {
    const s = new DocumentStore();
    s.load(fixtureProject());
    s.transact("edit", (p) => void (p.name = "Edited"));
    expect(s.getSnapshot().canUndo).toBe(true);
    s.loadReadOnly(fixtureProject());
    expect(s.getSnapshot().readOnly).toBe(true);
    expect(s.getSnapshot().canUndo).toBe(false);
    expect(() => s.transact("edit", (p) => void (p.name = "X"))).toThrow(READ_ONLY_MESSAGE);
    expect(s.undo()).toBe(false);
    expect(() => s.loadUnsaved(fixtureProject(), fixtureProject())).toThrow(READ_ONLY_MESSAGE);
    expect(s.project?.name).toBe("Fixture");
    expect(s.getSnapshot().isDirty).toBe(false);
    s.load(fixtureProject());
    expect(s.getSnapshot().readOnly).toBe(false);
    expect(s.transact("edit", (p) => void (p.name = "Y"))).toBe(true);
  });
});

describe("viewing guard", () => {
  const sess = (viewing: boolean) => ({ getSnapshot: () => ({ viewing: viewing ? {} : null }) }) as unknown as Session;
  it("lets everything through outside viewing mode", () => {
    expect(viewingGuard(sess(false), "model.addTable")).toBeNull();
  });
  it("in viewing mode allows only windows, panes, paging, drilling and leaving", () => {
    for (const id of ["app.options", "app.theme.toggle", "view.report", "view.zoom", "pane.toggle", "report.page.go", "report.view.drillUp", "report.visuals.refresh", "file.close", "file.open", "package.open.run"]) {
      expect(viewingGuard(sess(true), id), id).toBeNull();
    }
    for (const id of ["model.addTable", "model.deleteTable", "model.addMeasure", "data.import", "data.refreshAll", "file.save", "file.saveAs.run", "edit.undo", "report.visual.add", "report.visual.delete", "report.page.add", "report.page.rename", "report.format.set", "report.field.add", "view.data", "view.model", "view.dax", "view.tmdl", "dax.query.run", "query.apply", "tmdl.apply", "publish.open", "publish.run"]) {
      expect(viewingGuard(sess(true), id), id).toBe(VIEWING_MESSAGE);
    }
  });
  it("disables the command and explains why, whatever the command's own rule says", async () => {
    const r = new CommandRegistry<Session>(sess(true));
    let ran = false;
    r.register({ id: "model.addTable", label: "Add table", run: () => void (ran = true) });
    r.setGuard(viewingGuard);
    expect(r.isEnabled("model.addTable")).toBe(false);
    const res = await r.execute("model.addTable");
    expect(res).toEqual({ ok: false, reason: "disabled", message: VIEWING_MESSAGE });
    expect(ran).toBe(false);
  });
});

describe("pruneForPublishing", () => {
  const all = (p = fixtureProject()) => listTables(p).map((t) => ({ table: t.name, columns: t.columns.map((c) => c.name) }));

  it("keeps everything when everything is chosen (and strips data source definitions)", () => {
    const p = fixtureProject();
    const out = pruneForPublishing(p, all(p));
    expect(listTables(out.project).map((t) => t.name).sort()).toEqual(["Customer", "Date", "Product", "Sales"]);
    expect(out.warnings).toEqual([]);
    // the input is untouched
    expect(listTables(p).length).toBe(4);
  });

  it("drops unchosen tables and columns, and measures that use them are reported", () => {
    const p = fixtureProject({ Sales: [{ name: "Total", expr: "SUM(Sales[UnitPrice])" }, { name: "Qty", expr: "SUM('Sales'[Quantity])" }] });
    const sel = all(p).filter((t) => t.table !== "Customer").map((t) => (t.table === "Sales" ? { ...t, columns: t.columns.filter((c) => c !== "UnitPrice") } : t));
    const out = pruneForPublishing(p, sel);
    const names = listTables(out.project).map((t) => t.name);
    expect(names).not.toContain("Customer");
    const sales = listTables(out.project).find((t) => t.name === "Sales")!;
    expect(sales.columns.map((c) => c.name)).not.toContain("UnitPrice");
    expect(sales.columns.map((c) => c.name)).toContain("Quantity");
    expect(out.warnings.some((w) => w.includes('Measure "Total"') && w.includes("Sales[UnitPrice]"))).toBe(true);
    expect(out.warnings.some((w) => w.includes('"Qty"'))).toBe(false);
  });

  it("removes relationships whose columns are gone and table references to removed tables", () => {
    const p = fixtureProject();
    p.model.tmdl["relationships.tmdl"] = {
      nodes: [
        { description: [], kind: "relationship", name: "r1", default: null, children: [], props: [{ key: "fromColumn", value: { Text: "Sales.CustomerKey" } }, { key: "toColumn", value: { Text: "Customer.CustomerKey" } }] },
        { description: [], kind: "relationship", name: "r2", default: null, children: [], props: [{ key: "fromColumn", value: { Text: "Sales.ProductKey" } }, { key: "toColumn", value: { Text: "Product.ProductKey" } }] },
      ],
    };
    p.model.tmdl["model.tmdl"].nodes.push({ description: [], kind: "ref table", name: "Customer", default: null, props: [], children: [] });
    const sel = all(p).map((t) => (t.table === "Sales" ? { ...t, columns: t.columns.filter((c) => c !== "ProductKey") } : t));
    const out = pruneForPublishing(p, sel.filter((t) => t.table !== "Customer"));
    const rels = Object.values(out.project.model.tmdl).flatMap((d) => d.nodes.filter((n) => n.kind === "relationship"));
    expect(rels).toEqual([]);
    expect(out.project.model.tmdl["model.tmdl"].nodes.some((n) => n.kind === "ref table" && n.name === "Customer")).toBe(false);
  });

  it("removes M partitions and named queries (they carry local paths)", () => {
    const p = fixtureProject();
    const sales = allTables(p).find((t) => t.name === "Sales")!;
    sales.children.push({ description: [], kind: "partition", name: "Sales", default: { text: 'Csv.Document(File.Contents("C:\\Users\\ann\\sales.csv"))', verbatim: false }, props: [], children: [] });
    p.model.tmdl["expressions.tmdl"] = { nodes: [{ description: [], kind: "expression", name: "Q", default: { text: "let x = 1 in x", verbatim: false }, props: [], children: [] }] };
    const out = pruneForPublishing(p, all(p));
    const text = JSON.stringify(out.project.model.tmdl);
    expect(text).not.toContain("sales.csv");
    expect(text).not.toContain("Users");
    expect(text).not.toContain("let x = 1");
  });

  it("reports visuals that use something that was removed", () => {
    const p = fixtureProject();
    p.report.files["pages/page1/visuals/v1/visual.json"] = {
      visual: { query: { queryState: { Y: { projections: [{ field: { Column: { Expression: { SourceRef: { Entity: "Sales" } }, Property: "UnitPrice" } } }] } } } },
    };
    const sel = all(p).map((t) => (t.table === "Sales" ? { ...t, columns: t.columns.filter((c) => c !== "UnitPrice") } : t));
    const out = pruneForPublishing(p, sel);
    expect(out.warnings.some((w) => w.includes("Sales[UnitPrice]") && w.includes("visual"))).toBe(true);
  });

  it("sameSelection ignores order", () => {
    expect(sameSelection([{ table: "A", columns: ["x", "y"] }, { table: "B", columns: ["z"] }], [{ table: "B", columns: ["z"] }, { table: "A", columns: ["y", "x"] }])).toBe(true);
    expect(sameSelection([{ table: "A", columns: ["x"] }], [{ table: "A", columns: ["x", "y"] }])).toBe(false);
  });
});

describe("setup guides", () => {
  const byId = (id: string) => getGuide(id)!;
  const labels = (id: string) => byId(id).buttons.map((b) => b.label);

  it("backend hosting says what to do and offers the three buttons", () => {
    expect(byId("backend-host").paragraphs[0]).toBe("To host a shared workspace for others, either turn on Host from this PC (BIForge must stay open and this PC online), or install biforge-server.exe on a computer that stays on.");
    expect(labels("backend-host")).toEqual(["Turn on Host from this PC", "Download biforge-server.exe", "How it works"]);
    expect(byId("backend-host").howItWorks!.length).toBeGreaterThan(1);
  });
  it("backend connecting needs no install", () => {
    expect(byId("backend-connect").paragraphs).toEqual(["Enter the server address your host gave you, or open the invite link they sent.", "Nothing needs to be installed."]);
  });
  it("static hosting explains public vs private, the free account, and lists the data", () => {
    for (const id of ["static-github-pages", "static-cloudflare-pages"]) {
      const g = byId(id);
      const text = g.paragraphs.join(" ");
      expect(text).toMatch(/Public: anyone can open it\. Private:/);
      expect(text).toMatch(/free .* account/i);
      expect(text).toMatch(/never asks for a payment card/);
      expect(g.listsData).toBe(true);
    }
    expect(labels("static-github-pages")).toContain("Connect GitHub");
    expect(labels("static-cloudflare-pages")).toContain("Connect Cloudflare");
  });
  it("personal storage says it shares the editable project, not a live dashboard", () => {
    for (const [id, button] of [["storage-google-drive", "Connect Google Drive"], ["storage-onedrive", "Connect OneDrive"], ["storage-dropbox", "Connect Dropbox"]] as const) {
      expect(byId(id).paragraphs.join(" ")).toMatch(/shares the editable project file .*not a live dashboard/);
      expect(labels(id)).toContain(button);
      expect(byId(id).listsData).toBe(true);
    }
  });
  it("P2P says both must be online, that it may fail, and what to do then", () => {
    const text = byId("p2p").paragraphs.join(" ");
    expect(text).toMatch(/online at the same time/);
    expect(text).toMatch(/may not work on some networks/);
    expect(text).toMatch(/use another method/);
    expect(labels("p2p")).toEqual(["Start session", "Join with code"]);
  });
  it("scheduled refresh names where it runs and what must stay on", () => {
    const t = byId("scheduled-refresh").paragraphs.join(" ");
    expect(t).toMatch(/GitHub Actions/);
    expect(t).toMatch(/this PC/);
    expect(t).toMatch(/server you host/);
    expect(t).toMatch(/must stay on|stay on/);
  });
  it("every button of a guide for something not built yet is marked with its phase, and none is a fake", () => {
    const adapters = defaultAdapters();
    for (const g of allGuides()) {
      for (const b of g.buttons) {
        if (b.action.kind === "notImplemented") expect(b.action.phase, `${g.id}/${b.label}`).toMatch(/^O[2-7]$/);
      }
    }
    // the only guide that can start something today is the folder one
    const live = allGuides().filter((g) => g.buttons.some((b) => b.action.kind === "pickFolder"));
    expect(live.map((g) => g.id)).toEqual(["local-folder"]);
    expect(adapters.length).toBeGreaterThan(1);
  });
  it("every adapter that is not a folder maps to a guide, every guide id exists, and no guide mentions payment as a step", () => {
    for (const g of Object.values(GUIDE_FOR_ADAPTER)) expect(getGuide(g), g).toBeDefined();
    for (const a of ["github-pages", "cloudflare-pages", "google-drive", "onedrive", "dropbox", "p2p", "host-from-pc", "biforge-server", "local-folder"]) expect(guideForAdapter(a), a).toBeDefined();
    for (const g of allGuides()) expect(g.paragraphs.join(" ")).not.toMatch(/credit card|pay now|subscribe|upgrade/i);
  });
  it("shows the provider's free limits, taken from the adapter", () => {
    const g = getGuide("storage-google-drive")!;
    expect(freeTierLines(g, defaultAdapters())).toEqual(["Free Google account, 15 GB shared with Gmail and Photos"]);
    expect(freeTierLines(getGuide("backend-host")!, defaultAdapters())).toEqual(["Free; uses your PC"]);
  });
});
