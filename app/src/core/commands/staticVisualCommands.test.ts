import { describe, expect, it } from "vitest";
import { createRegistry } from "./builtin";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { Session } from "../session/session";
import { lit } from "../report/fields";
import { fixtureProject } from "../report/testFixture";
import { actionProblem, readAction, readShape, readTextbox, rotationOf, shapeSvg, writeTextbox } from "../report/staticVisuals";
import { FormatReader } from "../report/formatReader";
import { resolveTheme } from "../report/theme";
import { getFormat, listPageNames, parsePage, visualKey } from "../report/visualDoc";
import { listBookmarks } from "../report/bookmarks";

function setup() {
  const io = new FakeIO();
  const dialogs = new FakeDialogs();
  const session = new Session(io, dialogs);
  session.store.load(fixtureProject());
  const reg = createRegistry(session);
  session.report.goToPage("page1");
  const run = async (id: string, args?: unknown) => {
    const r = await reg.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  const fail = async (id: string, args?: unknown) => {
    const r = await reg.execute(id, args);
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.message;
  };
  const visuals = (page = "page1") => parsePage(session.store.project!, page)!.visuals;
  return { session, io, dialogs, reg, run, fail, visuals };
}

describe("text box", () => {
  it("is added with text, edited through one command, and read back with its style", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "textbox" });
    const v = t.visuals()[0];
    expect(v.visualType).toBe("textbox");
    expect(readTextbox(v.json).text).toBe("Text box");
    await t.run("report.textbox.set", { page: "page1", visual: v.name, patch: { text: "Line one\nLine two", fontSize: 20, bold: true, italic: true, underline: true, color: "#112233", align: "center" } });
    const m = readTextbox(t.visuals()[0].json);
    expect(m).toEqual({ text: "Line one\nLine two", fontSize: 20, bold: true, italic: true, underline: true, color: "#112233", align: "center" });
    // PBIR layout: one paragraph per line, text runs carry the style
    const para = (t.session.store.project!.report.files[visualKey("page1", v.name)] as any).visual.objects.general[0].properties.paragraphs;
    expect(para).toHaveLength(2);
    expect(para[0].textRuns[0].textStyle.fontSize).toBe("20pt");
    expect(para[1].horizontalTextAlignment).toBe("center");
    await t.run("edit.undo");
    expect(readTextbox(t.visuals()[0].json).text).toBe("Text box");
  });

  it("refuses to edit another kind of visual as a text box", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "shape" });
    expect(await t.fail("report.textbox.set", { page: "page1", visual: t.visuals()[0].name, patch: { text: "x" } })).toMatch(/is not a textbox/);
  });

  it("writeTextbox keeps unknown content of other objects", () => {
    const json: any = { visual: { visualType: "textbox", objects: { other: [{ properties: { x: 1 } }] } } };
    writeTextbox(json, { text: "a" });
    expect(json.visual.objects.other[0].properties.x).toBe(1);
    expect(readTextbox(json).text).toBe("a");
  });
});

describe("shape", () => {
  it("each shape of the menu is added with its tile shape; fill, outline and rotation are format settings", async () => {
    const t = setup();
    for (const shape of ["rectangle", "roundedRectangle", "oval", "triangle", "line"]) await t.run("report.visual.add", { type: "shape", format: [{ object: "shape", prop: "tileShape", value: lit.str(shape) }] });
    expect(t.visuals().map((v) => getFormat(v.json, "shape", "tileShape"))).toEqual(["rectangle", "roundedRectangle", "oval", "triangle", "line"].map(lit.str));
    const v = t.visuals()[2];
    await t.run("report.format.set", { page: "page1", visual: v.name, object: "fill", prop: "fillColor", value: lit.str("#ff0000") });
    await t.run("report.format.set", { page: "page1", visual: v.name, object: "fill", prop: "transparency", value: lit.num(40) });
    await t.run("report.format.set", { page: "page1", visual: v.name, object: "outline", prop: "weight", value: lit.num(4) });
    await t.run("report.format.set", { page: "page1", visual: v.name, object: "rotation", prop: "angle", value: lit.num(45) });
    const cur = t.visuals()[2];
    const model = readShape(new FormatReader(cur.json, resolveTheme(t.session.store.project!), "shape"));
    expect(model.shape).toBe("oval");
    expect(model.fill).toEqual({ show: true, color: "#ff0000", transparency: 40 });
    expect(model.outline.weight).toBe(4);
    expect(rotationOf(cur)).toBe(45);
  });

  it("draws every shape as SVG inside its box", () => {
    const base = { fill: { show: true, color: "#abc", transparency: 50 }, outline: { show: true, color: "#000", weight: 2 } };
    expect(shapeSvg({ shape: "rectangle", ...base }, 100, 50)).toMatchObject({ tag: "rect", attrs: { x: 1, y: 1, width: 98, height: 48, "fill-opacity": 0.5 } });
    expect(shapeSvg({ shape: "oval", ...base }, 100, 50)).toMatchObject({ tag: "ellipse", attrs: { cx: 50, cy: 25, rx: 49, ry: 24 } });
    expect(shapeSvg({ shape: "triangle", ...base }, 100, 50).attrs.points).toBe("50,1 99,49 1,49");
    expect(shapeSvg({ shape: "line", ...base }, 100, 50)).toMatchObject({ tag: "line", attrs: { x1: 0, x2: 100, fill: "none" } });
    expect(shapeSvg({ shape: "rectangle", fill: { ...base.fill, show: false }, outline: { ...base.outline, show: false } }, 10, 10).attrs).toMatchObject({ fill: "none", stroke: "none" });
  });
});

describe("image", () => {
  it("Insert > Image picks a file, reads it as a data URI and adds an image visual; undo removes it", async () => {
    const t = setup();
    t.dialogs.file = "C:/pics/logo.png";
    t.io.images.set("C:/pics/logo.png", "data:image/png;base64,AAAA");
    await t.run("report.image.insert");
    const v = t.visuals()[0];
    expect(v.visualType).toBe("image");
    expect(getFormat(v.json, "image", "imageUrl")).toEqual(lit.str("data:image/png;base64,AAAA"));
    await t.run("edit.undo");
    expect(t.visuals()).toHaveLength(0);
  });

  it("cancelling the picker adds nothing; an unreadable file reports why", async () => {
    const t = setup();
    t.dialogs.file = null;
    await t.run("report.image.insert");
    expect(t.visuals()).toHaveLength(0);
    t.dialogs.file = "C:/missing.png";
    expect(await t.fail("report.image.insert")).toMatch(/cannot read/);
    expect(t.visuals()).toHaveLength(0);
  });

  it("choose replaces the picture of an existing image", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "image" });
    t.dialogs.file = "C:/pics/b.png";
    t.io.images.set("C:/pics/b.png", "data:image/png;base64,BBBB");
    await t.run("report.image.choose", { page: "page1", visual: t.visuals()[0].name });
    expect(getFormat(t.visuals()[0].json, "image", "imageUrl")).toEqual(lit.str("data:image/png;base64,BBBB"));
  });
});

describe("button actions", () => {
  async function button(t: ReturnType<typeof setup>, type: string, extra: { prop: string; value: string }[] = []) {
    await t.run("report.visual.add", { type: "actionButton", format: [{ object: "visualLink", prop: "type", value: lit.str(type) }, ...extra.map((e) => ({ object: "visualLink", prop: e.prop, value: lit.str(e.value) }))] });
    return t.visuals().at(-1)!.name;
  }

  it("page navigation goes to the page; a page that no longer exists is reported", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Second" });
    const second = t.session.report.getSnapshot().page!;
    await t.run("report.page.go", { page: "page1" });
    const b = await button(t, "PageNavigation", [{ prop: "navigationSection", value: second }]);
    await t.run("report.button.run", { page: "page1", visual: b });
    expect(t.session.report.getSnapshot().page).toBe(second);
    await t.run("report.page.go", { page: "page1" });
    const lost = await button(t, "PageNavigation", [{ prop: "navigationSection", value: "gone" }]);
    expect(await t.fail("report.button.run", { page: "page1", visual: lost })).toMatch(/no longer exists/);
    const none = await button(t, "PageNavigation");
    expect(await t.fail("report.button.run", { page: "page1", visual: none })).toMatch(/No page is chosen/);
  });

  it("bookmark applies the bookmark", async () => {
    const t = setup();
    await t.run("report.bookmark.add", { name: "Here" });
    const [bm] = listBookmarks(t.session.store.project!);
    await t.run("report.page.add", { name: "Other" });
    await t.run("report.page.go", { page: "page1" });
    const b = await button(t, "Bookmark", [{ prop: "bookmark", value: bm.id }]);
    const other = listPageNames(t.session.store.project!).find((n) => n !== "page1")!;
    await t.run("report.page.go", { page: other });
    await t.run("report.button.run", { page: "page1", visual: b });
    expect(t.session.report.getSnapshot().page).toBe("page1");
  });

  it("web URL opens http and https addresses only", async () => {
    const t = setup();
    const ok = await button(t, "WebUrl", [{ prop: "webUrl", value: "https://example.org/report" }]);
    await t.run("report.button.run", { page: "page1", visual: ok });
    expect(t.io.opened).toEqual(["https://example.org/report"]);
    const bad = await button(t, "WebUrl", [{ prop: "webUrl", value: "file:///c:/windows/notepad.exe" }]);
    expect(await t.fail("report.button.run", { page: "page1", visual: bad })).toMatch(/must start with http/);
    expect(t.io.opened).toHaveLength(1);
  });

  it("back returns from a drillthrough page; a blank button does nothing", async () => {
    const t = setup();
    const back = await button(t, "Back");
    await t.run("report.button.run", { page: "page1", visual: back });
    const blank = await button(t, "None");
    const rev = t.session.store.getSnapshot().revision;
    await t.run("report.button.run", { page: "page1", visual: blank });
    expect(t.session.store.getSnapshot().revision).toBe(rev);
  });

  it("actionProblem and readAction", () => {
    expect(actionProblem({ type: "PageNavigation", page: "a" }, ["a"], [])).toBeNull();
    expect(actionProblem({ type: "Bookmark", bookmark: "x" }, [], [])).toMatch(/no longer exists/);
    expect(actionProblem({ type: "WebUrl", url: "javascript:alert(1)" }, [], [])).toMatch(/http/);
    expect(readAction({ visual: { objects: {} } } as any)).toEqual({ type: "None", page: undefined, bookmark: undefined, url: undefined });
  });
});

describe("a report opened for viewing", () => {
  it("can still change page and run page buttons (the read-only store is not touched)", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Second" });
    const second = t.session.report.getSnapshot().page!;
    await t.run("report.page.go", { page: "page1" });
    await t.run("report.visual.add", { type: "actionButton", format: [{ object: "visualLink", prop: "type", value: lit.str("PageNavigation") }, { object: "visualLink", prop: "navigationSection", value: lit.str(second) }] });
    const b = t.visuals()[0].name;
    t.session.store.loadReadOnly(t.session.store.project!);
    const rev = t.session.store.getSnapshot().revision;
    await t.run("report.page.go", { page: second });
    expect(t.session.report.getSnapshot().page).toBe(second);
    await t.run("report.page.go", { page: "page1" });
    await t.run("report.button.run", { page: "page1", visual: b });
    expect(t.session.report.getSnapshot().page).toBe(second);
    expect(t.session.store.getSnapshot().revision).toBe(rev);
  });
});
