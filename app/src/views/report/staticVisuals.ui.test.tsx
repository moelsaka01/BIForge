// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import { lit } from "../../core/report/fields";
import { fixtureProject } from "../../core/report/testFixture";
import { getFormat, parsePage } from "../../core/report/visualDoc";
import { readTextbox } from "../../core/report/staticVisuals";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

function setup(readOnly = false) {
  const session = new Session(new FakeIO(), new FakeDialogs());
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  const run = async (id: string, args?: unknown) => {
    const r = await registry.execute(id, args);
    if (!r.ok) throw new Error(r.message);
  };
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} readOnly={readOnly} />;
  }
  const visuals = () => parsePage(session.store.project!, "page1")!.visuals;
  return { session, run, Host, visuals };
}

const select = async (name: string) => fireEvent.pointerDown(await waitFor(() => document.querySelector(`[data-visual="${name}"]`) as HTMLElement), { button: 0 });

describe("objects without data on the canvas", () => {
  it("a text box shows its text with its style", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "textbox" });
    await t.run("report.textbox.set", { page: "page1", visual: t.visuals()[0].name, patch: { text: "Quarterly review", bold: true, fontSize: 24, align: "center", color: "#336699" } });
    render(<t.Host />);
    const box = await screen.findByTestId("textbox");
    expect(box.textContent).toBe("Quarterly review");
    expect(box.style.fontWeight).toBe("700");
    expect(box.style.fontSize).toBe("24px");
    expect(box.style.textAlign).toBe("center");
    expect(box.style.color).toBe("rgb(51, 102, 153)");
  });

  it("the Format pane edits the text box content and style", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "textbox" });
    const v = t.visuals()[0];
    render(<t.Host />);
    await select(v.name);
    fireEvent.click(await screen.findByRole("tab", { name: "Format visual" }));
    const area = (await screen.findByLabelText("Text box content")) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "Hello\nWorld" } });
    fireEvent.blur(area);
    await waitFor(() => expect(readTextbox(t.visuals()[0].json).text).toBe("Hello\nWorld"));
    fireEvent.click(screen.getByRole("switch", { name: "Italic" }));
    await waitFor(() => expect(readTextbox(t.visuals()[0].json).italic).toBe(true));
    expect((await screen.findByTestId("textbox")).textContent).toBe("Hello\nWorld");
  });

  it("shapes draw as SVG and rotate; a line has no fill", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "shape", format: [{ object: "shape", prop: "tileShape", value: lit.str("oval") }, { object: "rotation", prop: "angle", value: lit.num(30) }] });
    await t.run("report.visual.add", { type: "shape", format: [{ object: "shape", prop: "tileShape", value: lit.str("line") }] });
    render(<t.Host />);
    await waitFor(() => expect(document.querySelectorAll("svg[data-shape]")).toHaveLength(2));
    expect(document.querySelector("svg[data-shape=oval] ellipse")).toBeTruthy();
    expect(document.querySelector("svg[data-shape=line] line")).toBeTruthy();
    const rotated = document.querySelector("svg[data-shape=oval]")!.closest("div[style*=rotate]") as HTMLElement;
    expect(rotated.style.transform).toBe("rotate(30deg)");
  });

  it("a shape shows its text and glow, a navigator can hide its names and a button turns its text", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "shape" });
    await t.run("report.visual.add", { type: "pageNavigator" });
    await t.run("report.visual.add", { type: "actionButton" });
    const by = (ty: string) => t.visuals().find((v) => v.visualType === ty)!.name;
    const fmt = (ty: string, object: string, prop: string, value: ReturnType<typeof lit.str>) => t.run("report.format.set", { page: "page1", visual: by(ty), object, prop, value });
    await fmt("shape", "text", "show", lit.bool(true) as never);
    await fmt("shape", "text", "text", lit.str("Inside"));
    await fmt("shape", "glow", "show", lit.bool(true) as never);
    await fmt("pageNavigator", "text", "show", lit.bool(false) as never);
    await fmt("actionButton", "rotation", "textAngle", lit.num(15) as never);
    render(<t.Host />);
    expect((await screen.findByTestId("shape-text")).textContent).toBe("Inside");
    expect((screen.getByTestId("shape-layer") as HTMLElement).style.filter).toContain("drop-shadow(0px 0px 8px");
    const nav = await screen.findByRole("navigation", { name: "Page navigator" });
    expect(within(nav).getAllByRole("button").every((b) => b.textContent === "")).toBe(true);
    expect((screen.getByTestId("button-text") as HTMLElement).style.transform).toBe("rotate(15deg)");
  });

  it("an image shows its picture with the alt text; without one it says so", async () => {
    const t = setup();
    await t.run("report.visual.add", { type: "image" });
    const v = t.visuals()[0];
    render(<t.Host />);
    expect(await screen.findByText(/No image yet/)).toBeTruthy();
    await t.run("report.format.set", { page: "page1", visual: v.name, object: "image", prop: "sourceUrl", value: lit.str("data:image/png;base64,AAAA") });
    await t.run("report.format.set", { page: "page1", visual: v.name, object: "general", prop: "altText", value: lit.str("Company logo") });
    await t.run("report.format.set", { page: "page1", visual: v.name, object: "image", prop: "fit", value: lit.str("Fill") });
    const img = (await screen.findByTestId("image")) as HTMLImageElement;
    expect(img.src).toBe("data:image/png;base64,AAAA");
    expect(img.style.objectFit).toBe("cover");
    expect(screen.getByRole("group", { name: "Visual: Company logo" })).toBeTruthy();
  });

  it("a page button goes to its page on Ctrl+click while editing and never on a plain click", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Details" });
    const details = t.session.report.getSnapshot().page!;
    await t.run("report.page.go", { page: "page1" });
    await t.run("report.visual.add", { type: "actionButton", format: [{ object: "visualLink", prop: "type", value: lit.str("PageNavigation") }, { object: "visualLink", prop: "navigationSection", value: lit.str(details) }, { object: "text", prop: "text", value: lit.str("Go to details") }] });
    render(<t.Host />);
    const btn = await screen.findByRole("button", { name: "Go to details" });
    fireEvent.click(btn);
    expect(t.session.report.getSnapshot().page).toBe("page1");
    fireEvent.click(btn, { ctrlKey: true });
    await waitFor(() => expect(t.session.report.getSnapshot().page).toBe(details));
  });

  it("in viewing mode a plain click runs the action and the report is not changed", async () => {
    const edit = setup();
    await edit.run("report.page.add", { name: "Details" });
    const details = edit.session.report.getSnapshot().page!;
    await edit.run("report.page.go", { page: "page1" });
    await edit.run("report.visual.add", { type: "actionButton", format: [{ object: "visualLink", prop: "type", value: lit.str("PageNavigation") }, { object: "visualLink", prop: "navigationSection", value: lit.str(details) }, { object: "text", prop: "text", value: lit.str("Next") }] });
    const view = setup(true);
    view.session.store.loadReadOnly(edit.session.store.project!);
    const rev = view.session.store.getSnapshot().revision;
    render(<view.Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => expect(view.session.report.getSnapshot().page).toBe(details));
    expect(view.session.store.getSnapshot().revision).toBe(rev);
  });

  it("a page navigator lists the visible normal pages, marks the current one and switches pages", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Second" });
    await t.run("report.page.add", { name: "Tip", type: "Tooltip" });
    await t.run("report.page.add", { name: "Secret" });
    const secret = t.session.report.getSnapshot().page!;
    await t.run("report.page.setHidden", { page: secret, hidden: true });
    await t.run("report.page.go", { page: "page1" });
    await t.run("report.visual.add", { type: "pageNavigator" });
    render(<t.Host />);
    const nav = await screen.findByRole("navigation", { name: "Page navigator" });
    const names = within(nav).getAllByRole("button").map((b) => b.textContent);
    expect(names).toHaveLength(2);
    expect(names).toContain("Second");
    expect(names).not.toContain("Tip");
    expect(names).not.toContain("Secret");
    expect(within(nav).getAllByRole("button").filter((b) => b.getAttribute("aria-current") === "page")).toHaveLength(1);
    fireEvent.click(within(nav).getByRole("button", { name: "Second" }));
    await waitFor(() => expect(t.session.report.getSnapshot().page).not.toBe("page1"));
  });

  it("a bookmark navigator lists the bookmarks in order and a click applies one (here: goes to its page)", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Second" });
    await t.run("report.bookmark.add", { name: "On second" });
    await t.run("report.page.go", { page: "page1" });
    await t.run("report.bookmark.add", { name: "On first" });
    await t.run("report.visual.add", { type: "bookmarkNavigator" });
    render(<t.Host />);
    const nav = await screen.findByRole("navigation", { name: "Bookmark navigator" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["On second", "On first"]);
    expect(t.session.report.getSnapshot().page).toBe("page1");
    fireEvent.click(within(nav).getByRole("button", { name: "On second" }));
    await waitFor(() => expect(t.session.report.getSnapshot().page).not.toBe("page1"));
  });

  it("the Format pane offers the Action card for a button with the report's pages", async () => {
    const t = setup();
    await t.run("report.page.add", { name: "Details" });
    await t.run("report.page.go", { page: "page1" });
    await t.run("report.visual.add", { type: "actionButton" });
    render(<t.Host />);
    await select(t.visuals()[0].name);
    fireEvent.click(await screen.findByRole("tab", { name: "Format visual" }));
    await screen.findByText("Action");
    const type = (await screen.findByLabelText("Type")) as HTMLSelectElement;
    fireEvent.change(type, { target: { value: "PageNavigation" } });
    await waitFor(() => expect(getFormat(t.visuals()[0].json, "visualLink", "type")).toEqual(lit.str("PageNavigation")));
    const page = (await screen.findByLabelText("Page")) as HTMLSelectElement;
    expect([...page.options].map((o) => o.textContent)).toContain("Details");
  });

  it("static objects are inserted from the Insert tab, not offered in the visual gallery", async () => {
    const t = setup();
    render(<t.Host />);
    const gallery = await screen.findByRole("group", { name: "Visual types" });
    for (const n of ["Text box", "Shape", "Image", "Button", "Page navigator", "Bookmark navigator"]) expect(within(gallery).queryByRole("button", { name: n }), n).toBeNull();
  });
});
