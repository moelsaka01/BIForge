// @vitest-environment jsdom
// Format page: size presets, page view, canvas background and wallpaper (color, transparency, picture) are written to
// page.json and drawn.
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRegistry } from "../../core/commands/builtin";
import { installDomStubs } from "../../core/testing/domStubs";
import { FakeDax } from "../../core/testing/fakeDax";
import { FakeDialogs, FakeIO } from "../../core/testing/fakes";
import { Session } from "../../core/session/session";
import type { J } from "../../core/report/pbir";
import { fixtureProject } from "../../core/report/testFixture";
import { readCanvasBackground, readVerticalAlignment, readWallpaper, sizePresetOf } from "../../core/report/pageFormat";
import { ReportView, plainDocks } from "./ReportView";

installDomStubs();
afterEach(cleanup);

function setup() {
  const io = new FakeIO();
  const dialogs = new FakeDialogs();
  const session = new Session(io, dialogs);
  session.store.load(fixtureProject());
  const registry = createRegistry(session);
  session.report.goToPage("page1");
  const dax = new FakeDax();
  function Host() {
    const doc = useSyncExternalStore(session.store.subscribe, session.store.getSnapshot);
    return <ReportView project={doc.project!} runtime={session.report} dax={dax} dispatch={(id, a) => void registry.execute(id, a)} dataEpoch={0} docks={plainDocks} />;
  }
  const page = (): J => (session.store.project!.report.files as Record<string, J>)["pages/page1/page.json"];
  return { io, dialogs, session, Host, page };
}

describe("Format page", () => {
  it("with no visual selected the Format tab is the page's: size, view, background and wallpaper", async () => {
    const t = setup();
    render(<t.Host />);
    fireEvent.click(await screen.findByRole("tab", { name: "Format page" }));
    const pane = await screen.findByLabelText("Format page");
    expect(pane).toBeTruthy();
    expect((screen.getByLabelText("Page size type") as HTMLSelectElement).value).toBe("16:9");
    fireEvent.change(screen.getByLabelText("Page size type"), { target: { value: "4:3" } });
    await waitFor(() => expect([t.page().width, t.page().height]).toEqual([960, 720]));
    expect(sizePresetOf(960, 720)).toBe("4:3");
    expect(sizePresetOf(1000, 700)).toBe("Custom");
    fireEvent.change(screen.getByLabelText("Page height"), { target: { value: "800" } });
    await waitFor(() => expect(t.page().height).toBe(800));
    await waitFor(() => expect((screen.getByLabelText("Page size type") as HTMLSelectElement).value).toBe("Custom"));
    fireEvent.change(screen.getByLabelText("Page vertical alignment"), { target: { value: "Middle" } });
    await waitFor(() => expect(readVerticalAlignment(t.page())).toBe("Middle"));
    await waitFor(() => expect(screen.getByTestId("wallpaper").style.alignItems).toBe("center"));
    fireEvent.change(screen.getByLabelText("Page view"), { target: { value: "FitToWidth" } });
    await waitFor(() => expect(t.page().displayOption).toBe("FitToWidth"));
  });

  it("the canvas background color and transparency are stored and drawn; Reset removes them", async () => {
    const t = setup();
    render(<t.Host />);
    fireEvent.click(await screen.findByRole("tab", { name: "Format page" }));
    fireEvent.change(await screen.findByLabelText("Canvas background: color"), { target: { value: "#336699" } });
    await waitFor(() => expect(readCanvasBackground(t.page()).color).toBe("#336699"));
    fireEvent.change(screen.getByLabelText("Canvas background: transparency"), { target: { value: "50" } });
    await waitFor(() => expect(readCanvasBackground(t.page()).transparency).toBe(50));
    const canvas = document.querySelector("[data-page]") as HTMLElement;
    await waitFor(() => expect(canvas.style.backgroundColor).toBe("rgba(51, 102, 153, 0.5)"));
    fireEvent.click(screen.getByLabelText("Canvas background: reset color"));
    await waitFor(() => expect(readCanvasBackground(t.page()).color).toBeNull());
  });

  it("a wallpaper color and picture fill the area around the page; the picture can be fitted and removed", async () => {
    const t = setup();
    t.io.images.set("C:/pics/sky.png", "data:image/png;base64,AAAA");
    t.dialogs.file = "C:/pics/sky.png";
    render(<t.Host />);
    fireEvent.click(await screen.findByRole("tab", { name: "Format page" }));
    fireEvent.change(await screen.findByLabelText("Wallpaper: color"), { target: { value: "#223344" } });
    await waitFor(() => expect(readWallpaper(t.page()).color).toBe("#223344"));
    const wall = screen.getByTestId("wallpaper");
    await waitFor(() => expect(wall.style.backgroundColor).toBe("rgb(34, 51, 68)"));
    fireEvent.click(screen.getByLabelText("Wallpaper: choose picture"));
    await waitFor(() => expect(readWallpaper(t.page()).image?.url).toBe("data:image/png;base64,AAAA"));
    expect(readWallpaper(t.page()).image?.name).toBe("sky.png");
    await waitFor(() => expect(wall.style.backgroundImage).toContain("data:image/png"));
    fireEvent.change(screen.getByLabelText("Wallpaper: image fit"), { target: { value: "Fill" } });
    await waitFor(() => expect(readWallpaper(t.page()).image?.fit).toBe("Fill"));
    expect(wall.style.backgroundSize).toBe("100% 100%");
    fireEvent.click(screen.getByLabelText("Wallpaper: remove picture"));
    await waitFor(() => expect(readWallpaper(t.page()).image).toBeNull());
  });

  it("the canvas background picture is drawn behind the visuals of the page", async () => {
    const t = setup();
    t.io.images.set("p.png", "data:image/png;base64,BBBB");
    t.dialogs.file = "p.png";
    render(<t.Host />);
    fireEvent.click(await screen.findByRole("tab", { name: "Format page" }));
    fireEvent.click(await screen.findByLabelText("Canvas background: choose picture"));
    const pic = await screen.findByTestId("page-picture");
    expect(pic.style.backgroundImage).toContain("data:image/png");
  });
});
