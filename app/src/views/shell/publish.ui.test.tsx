// @vitest-environment jsdom
// Publish & Share dialog, setup pop-ups, viewing mode and the open-shared-report flow, over fakes.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installDomStubs } from "../../core/testing/domStubs";
import { TABLE_COLUMNS, fixtureProject } from "../../core/report/testFixture";
import type { BiType } from "../../core/data/types";
import type { OpenedPackage } from "../../core/publish/types";
import { fakeFolderAdapter } from "../../core/testing/fakePublish";
import { applyImport } from "../../core/model/tables";
import { PBIP, ROOT, makeApp } from "./testApp";

installDomStubs();
afterEach(cleanup);

type App = ReturnType<typeof makeApp>;

function withData(a: App, tables = ["Sales", "Customer"]) {
  for (const t of tables) {
    a.engine.tables.set(t, {
      columns: Object.entries(TABLE_COLUMNS[t]).map(([name, ty]) => ({ name, duckdbType: ty, biType: ty as BiType })),
      rows: [],
    });
  }
}
async function openProject(a: App) {
  await act(async () => {
    await a.registry.execute("file.open", { path: PBIP });
  });
}
async function openPublish(a: App) {
  await act(async () => {
    await a.registry.execute("publish.open");
  });
  return screen.findByRole("dialog", { name: "Publish and Share" });
}
async function addFolderTarget(a: App, dlg: HTMLElement, access: "private" | "public" = "private") {
  a.shell.settings.setOption("publish.guide.local-folder.hidden", true); // the guide has its own test
  fireEvent.change(within(dlg).getByLabelText("Destination name"), { target: { value: "Team share" } });
  fireEvent.change(within(dlg).getByLabelText("Folder"), { target: { value: "C:\\Shared\\Reports" } });
  if (access === "public") fireEvent.click(within(dlg).getByRole("radio", { name: /Public/ }));
  fireEvent.click(within(dlg).getByRole("button", { name: "Add destination" }));
}

describe("the Publish & Share entry points", () => {
  it("are in the Home ribbon, the File menu and the start screen, and each opens its dialog", async () => {
    const a = makeApp();
    render(a.element);
    expect(within(screen.getByRole("navigation", { name: "Start" })).getByRole("button", { name: "Open shared report" })).toBeTruthy();
    withData(a);
    await openProject(a);
    const ribbon = within(screen.getByTestId("ribbon"));
    expect(ribbon.getByRole("button", { name: /Publish & Share/ })).toBeTruthy();
    expect(ribbon.getByRole("button", { name: /Open shared report/ })).toBeTruthy();
    fireEvent.click(ribbon.getByRole("button", { name: /Publish & Share/ }));
    expect(await screen.findByRole("dialog", { name: "Publish and Share" })).toBeTruthy();
  });
});

describe("destinations are driven by what each adapter declares", () => {
  it("lists every known destination, marks the ones not built as not implemented, and cannot add them", async () => {
    const a = makeApp();
    withData(a);
    render(a.element);
    await openProject(a);
    const dlg = await openPublish(a);
    fireEvent.click(within(dlg).getByRole("combobox", { name: "Destination type" }));
    const opts = await screen.findAllByRole("option");
    const text = opts.map((o) => o.textContent ?? "");
    expect(text.some((t) => /Folder on this PC/.test(t) && !/not implemented/.test(t))).toBe(true);
    expect(text.some((t) => /GitHub Pages/.test(t) && !/not implemented/.test(t))).toBe(true);
    for (const name of ["Google Drive", "Direct connection", "Host from this PC"]) {
      const o = opts.find((x) => (x.textContent ?? "").includes(name))!;
      expect(o.textContent, name).toMatch(/not implemented \(planned O\d\)/);
      expect(o.getAttribute("aria-disabled"), name).toBe("true");
    }
    // the command refuses too, even when the UI is bypassed
    const r = await a.registry.execute("publish.addTarget", { adapterId: "google-drive", label: "x", access: "public" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/not implemented yet \(planned for phase O3\)/);
    expect(a.publish.calls.filter((c) => c.startsWith("put:"))).toEqual([]);
  });

  it("offers private and public only when the adapter supports them", async () => {
    const a = makeApp();
    withData(a);
    a.publish.adapterList = [{ ...fakeFolderAdapter, capabilities: { ...fakeFolderAdapter.capabilities, publicAccess: false } }];
    render(a.element);
    await openProject(a);
    const dlg = await openPublish(a);
    expect((within(dlg).getByRole("radio", { name: /Public/ }) as HTMLInputElement).disabled).toBe(true);
    expect((within(dlg).getByRole("radio", { name: /Private/ }) as HTMLInputElement).disabled).toBe(false);
    const r = await a.registry.execute("publish.addTarget", { adapterId: "local-folder", label: "x", access: "public" });
    expect(!r.ok && r.message).toMatch(/does not support public reports/);
  });

  it("shows the destination, status, access level, account, last sync and limitations", async () => {
    const a = makeApp();
    withData(a);
    render(a.element);
    await openProject(a);
    const dlg = await openPublish(a);
    await addFolderTarget(a, dlg);
    const sec = await within(dlg).findByRole("region", { name: "Destination Team share" });
    const t = sec.textContent ?? "";
    expect(t).toMatch(/Destination\s*Team share \(Folder on this PC or network\)/);
    expect(t).toMatch(/Status\s*Not published yet/);
    expect(t).toMatch(/Access level\s*Private \(encrypted\)/);
    expect(t).toMatch(/Account\s*None needed/);
    expect(t).toMatch(/Last sync\s*Never/);
    expect(t).toMatch(/There is no access control/);
  });

  it("offers only the actions the adapter declares: no link, revoke or stop-sharing for an adapter that cannot", async () => {
    const full = makeApp();
    withData(full);
    render(full.element);
    await openProject(full);
    let dlg = await openPublish(full);
    await addFolderTarget(full, dlg);
    fireEvent.click(await within(dlg).findByRole("checkbox", { name: /I have checked this list/ }));
    fireEvent.change(within(dlg).getByLabelText("Publisher name"), { target: { value: "Ann" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Publish" }));
    await within(dlg).findByRole("button", { name: "Publish update" });
    for (const n of ["Create share link", "Revoke access (new key)", "Show access key", "Stop sharing"]) expect(within(dlg).getByRole("button", { name: n }), n).toBeTruthy();
    cleanup();

    const limited = makeApp();
    withData(limited);
    limited.publish.adapterList = [{ ...fakeFolderAdapter, capabilities: { ...fakeFolderAdapter.capabilities, shareLink: false, unpublish: false, keyRotation: false } }];
    render(limited.element);
    await openProject(limited);
    dlg = await openPublish(limited);
    await addFolderTarget(limited, dlg);
    fireEvent.click(await within(dlg).findByRole("checkbox", { name: /I have checked this list/ }));
    fireEvent.change(within(dlg).getByLabelText("Publisher name"), { target: { value: "Ann" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Publish" }));
    await within(dlg).findByRole("button", { name: "Publish update" });
    for (const n of ["Create share link", "Revoke access (new key)", "Stop sharing"]) expect(within(dlg).queryByRole("button", { name: n }), n).toBeNull();
    expect(within(dlg).getByRole("button", { name: "Show access key" })).toBeTruthy();
  });
});

describe("what leaves the computer", () => {
  it("lists every table and column, needs an explicit confirmation of exactly that list, and publishes exactly it", async () => {
    const a = makeApp();
    withData(a);
    render(a.element);
    await openProject(a);
    const dlg = await openPublish(a);
    await addFolderTarget(a, dlg);
    const fs = await within(dlg).findByRole("group", { name: "What leaves this computer" });
    expect(fs.textContent).toMatch(/Sales \(10 of 10 columns\)/);
    expect(fs.textContent).toMatch(/Customer \(6 of 6 columns\)/);

    const publish = () => within(dlg).getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    fireEvent.change(within(dlg).getByLabelText("Publisher name"), { target: { value: "Ann" } });
    expect(publish().disabled, "not confirmed yet").toBe(true);
    const confirm = within(dlg).getByRole("checkbox", { name: /I have checked this list/ }) as HTMLInputElement;
    fireEvent.click(confirm);
    expect(publish().disabled).toBe(false);

    // changing the selection withdraws the confirmation
    fireEvent.click(within(fs).getByRole("checkbox", { name: "Channel" }));
    expect((within(dlg).getByRole("checkbox", { name: /I have checked this list/ }) as HTMLInputElement).checked).toBe(false);
    expect(publish().disabled).toBe(true);
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /I have checked this list/ }));
    fireEvent.click(within(fs).getByRole("checkbox", { name: /^Customer \(/ })); // untick the whole table
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /I have checked this list/ }));
    fireEvent.click(publish());
    await waitFor(() => expect(a.publish.runs.length).toBe(1));
    const run = a.publish.runs[0];
    expect(run.args.included.map((t) => t.table)).toEqual(["Sales"]);
    expect(run.args.included[0].columns).not.toContain("Channel");
    expect(run.args.confirmed).toEqual(run.args.included);
    expect(run.args.publisherName).toBe("Ann");
    // the model that was sent has no Customer table and no Channel column
    const sent = run.project as ReturnType<typeof fixtureProject>;
    const tables = Object.values(sent.model.tmdl).flatMap((d) => d.nodes.filter((n) => n.kind === "table"));
    expect(tables.map((t) => t.name)).toEqual(["Sales"]);
    expect(tables[0].children.map((c) => c.name)).not.toContain("Channel");
  });

  it("warns when a measure or visual depends on something that is left out", async () => {
    const a = makeApp();
    withData(a);
    a.io.disk.set(ROOT, fixtureProject({ Sales: [{ name: "Avg price", expr: "AVERAGE(Sales[UnitPrice])" }] }));
    render(a.element);
    await openProject(a);
    const dlg = await openPublish(a);
    await addFolderTarget(a, dlg);
    const fs = await within(dlg).findByRole("group", { name: "What leaves this computer" });
    fireEvent.click(within(fs).getByRole("checkbox", { name: "UnitPrice" }));
    const w = await within(fs).findByRole("list", { name: "Warnings about the published copy" });
    expect(w.textContent).toMatch(/Measure "Avg price" uses the column Sales\[UnitPrice\]/);
  });
});

describe("a private publish shows the access key once and never puts it in the link", () => {
  it("publishes, shows the key, makes a link without it, revokes with a new key", async () => {
    const a = makeApp();
    withData(a);
    render(a.element);
    await openProject(a);
    const dlg = await openPublish(a);
    await addFolderTarget(a, dlg);
    fireEvent.click(await within(dlg).findByRole("checkbox", { name: /I have checked this list/ }));
    fireEvent.change(within(dlg).getByLabelText("Publisher name"), { target: { value: "Ann" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Publish" }));
    const status = await within(dlg).findByText(/Published version 1/);
    expect(status.parentElement!.textContent).toContain("AGE-SECRET-KEY-1FAKE");

    fireEvent.click(within(dlg).getByRole("button", { name: "Create share link" }));
    const linkBox = await within(dlg).findByText(/Share link \(it does not contain the access key\)/);
    expect(linkBox.textContent).toContain("biforge://open?src=file&path=");
    expect(linkBox.textContent).not.toContain("AGE-SECRET");

    a.publish.nextKey = "AGE-SECRET-KEY-1SECOND";
    fireEvent.click(within(dlg).getByRole("button", { name: "Revoke access (new key)" }));
    await within(dlg).findByText(/Access revoked: version 2/);
    expect(a.publish.calls).toContain("rotate:" + a.publish.runs[1].args.targetId);
    expect(within(dlg).getByText(/AGE-SECRET-KEY-1SECOND/)).toBeTruthy();
  });
});

describe("setup pop-ups", () => {
  it("the first use of a method shows the guide with the data list and free limits; Don't show again is remembered", async () => {
    const a = makeApp();
    withData(a);
    render(a.element);
    await openProject(a);
    const dlg = await openPublish(a);
    fireEvent.change(within(dlg).getByLabelText("Destination name"), { target: { value: "Share" } });
    fireEvent.change(within(dlg).getByLabelText("Folder"), { target: { value: "C:\\Shared" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add destination" }));
    const guide = await within(dlg).findByRole("group", { name: "Share through a folder" });
    expect(guide.textContent).toMatch(/No account is needed/);
    expect(within(guide).getByRole("list", { name: "Tables and columns that will leave this computer" }).textContent).toMatch(/Sales: SalesKey/);
    expect(guide.textContent).toMatch(/Free limits/);
    expect(guide.textContent).toMatch(/No account and no limits except the space on your disk/);
    expect(a.publish.calls.filter((c) => c.startsWith("put:"))).toEqual([]); // nothing was added before the guide was answered
    fireEvent.click(within(guide).getByRole("checkbox", { name: "Don't show again" }));
    fireEvent.click(within(guide).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(a.publish.calls.filter((c) => c.startsWith("put:")).length).toBe(1));
    expect(a.shell.settings.getSnapshot().options["publish.guide.local-folder.hidden"]).toBe(true);

    // the second destination goes straight in
    fireEvent.click(await within(dlg).findByRole("button", { name: "Add a destination" }));
    fireEvent.change(within(dlg).getByLabelText("Destination name"), { target: { value: "Second" } });
    fireEvent.change(within(dlg).getByLabelText("Folder"), { target: { value: "C:\\Shared2" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add destination" }));
    await waitFor(() => expect(a.publish.calls.filter((c) => c.startsWith("put:")).length).toBe(2));
    expect(within(dlg).queryByRole("group", { name: "Share through a folder" })).toBeNull();
  });

  it("a guide for a method that is not built shows its buttons disabled with the phase that builds them", async () => {
    const a = makeApp();
    withData(a);
    render(a.element);
    await openProject(a);
    await act(async () => {
      a.session.shell.openDialog({ kind: "guide", guideId: "backend-host" });
    });
    const dlg = await screen.findByRole("dialog", { name: "Host a shared workspace" });
    for (const [label, phase] of [["Turn on Host from this PC", "O5"], ["Download biforge-server.exe", "O5"]] as const) {
      const b = within(dlg).getByRole("button", { name: `${label} (not implemented)` }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe(`Not implemented yet (planned for phase ${phase})`);
    }
    expect(within(dlg).queryByRole("list", { name: "How it works" })).toBeNull();
    fireEvent.click(within(dlg).getByRole("button", { name: "How it works" }));
    expect(within(dlg).getByRole("list", { name: "How it works" }).textContent).toMatch(/no Docker needed/);
    expect(within(dlg).getByRole("checkbox", { name: "Don't show again" })).toBeTruthy();
  });
});

function prepareOpened(a: App, access: "public" | "private" = "public"): OpenedPackage {
  a.io.disk.set(ROOT, fixtureProject());
  const opened: OpenedPackage = {
    root: ROOT,
    pbipPath: PBIP,
    manifest: { formatVersion: 1, packageId: "pkg1", version: 4, reportName: "Sales report", publisher: { name: "Ann", keyId: "0123456789abcdef", publicKey: "k" }, access, included: [{ table: "Sales", columns: ["SalesKey", "Quantity"] }], createdAt: "2026-10-17T10:00:00Z", rlsEnforced: false },
    dataFiles: [["Sales", "C:/cache/Sales.parquet"]],
  };
  a.publish.opened = opened;
  a.engine.sources.set("C:/cache/Sales.parquet", { columns: [{ name: "SalesKey", duckdbType: "BIGINT", biType: "int64" }, { name: "Quantity", duckdbType: "BIGINT", biType: "int64" }], rows: [["1", "2"]] });
  return opened;
}

describe("viewing mode", () => {
  it("opens read only: ribbon replaced, no editing commands, nothing can change or be saved, then Close leaves it", async () => {
    const a = makeApp({ withProjectOnDisk: false });
    prepareOpened(a);
    render(a.element);
    await act(async () => {
      expect((await a.registry.execute("package.open.run", { path: "C:/share/pkg1.biforge" })).ok).toBe(true);
    });
    expect(a.publish.openedWith).toEqual([{ path: "C:/share/pkg1.biforge", key: null }]);
    const bar = await screen.findByRole("region", { name: "Viewing mode" });
    expect(bar.textContent).toMatch(/Sales report/);
    expect(bar.textContent).toMatch(/version 4/);
    expect(bar.textContent).toMatch(/published by Ann \(key 0123456789abcdef\)/);
    expect(bar.textContent).toMatch(/Read only/);
    expect(bar.textContent).toMatch(/Sales: SalesKey, Quantity/);
    expect(screen.queryByTestId("ribbon")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Views" })).toBeNull();
    expect(a.session.getSnapshot().viewing?.reportName).toBe("Sales report");
    expect(a.session.getSnapshot().dataTables).toEqual(["Sales"]);
    expect(a.shell.settings.getSnapshot().recent).toEqual([]);

    // every kind of change is refused, by the command registry and by the store itself
    for (const [id, args] of [
      ["model.addTable", { name: "X" }],
      ["model.addMeasure", { table: "Sales", name: "M", expression: "1" }],
      ["report.visual.add", { type: "card" }],
      ["report.page.add", {}],
      ["data.refreshAll", {}],
      ["file.save", {}],
      ["file.saveAs.run", { name: "Copy", folder: "C:/x" }],
      ["edit.undo", {}],
      ["view.model", {}],
      ["view.dax", {}],
      ["publish.open", {}],
    ] as const) {
      const r = await a.registry.execute(id, args);
      expect(r.ok, id).toBe(false);
      expect(!r.ok && r.message, id).toMatch(/open for viewing only/);
    }
    expect(() => a.session.store.transact("x", (p) => void (p.name = "changed"))).toThrow(/open for viewing only/);
    await expect(a.session.save()).rejects.toThrow(/cannot be saved/);
    expect(a.session.store.getSnapshot().isDirty).toBe(false);
    expect(a.io.calls.filter((c) => c.startsWith("save:"))).toEqual([]);

    // reading still works: paging, zoom, refreshing visuals
    expect((await a.registry.execute("view.zoom", { zoom: 0.5 })).ok).toBe(true);
    expect((await a.registry.execute("report.visuals.refresh")).ok).toBe(true);

    // the canvas has no way to add pages in viewing mode
    expect(screen.queryByRole("button", { name: "New page" })).toBeNull();

    fireEvent.click(within(bar).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(a.session.getSnapshot().viewing).toBeNull());
    expect(a.session.store.project).toBeNull();
    expect((await a.registry.execute("publish.open")).ok).toBe(false); // no project, so nothing to publish
  });

  it("opening a normal project afterwards makes it editable again", async () => {
    const a = makeApp();
    prepareOpened(a);
    render(a.element);
    await act(async () => void (await a.registry.execute("package.open.run", { path: "C:/share/pkg1.biforge" })));
    expect(a.session.store.getSnapshot().readOnly).toBe(true);
    await act(async () => void (await a.registry.execute("file.open", { path: PBIP })));
    expect(a.session.getSnapshot().viewing).toBeNull();
    expect(a.session.store.getSnapshot().readOnly).toBe(false);
    expect((await a.registry.execute("model.addTable", { name: "X" })).ok).toBe(true);
  });

  it("asks about unsaved changes before replacing the open project", async () => {
    const a = makeApp();
    withData(a);
    prepareOpened(a);
    a.io.disk.set(ROOT, fixtureProject());
    render(a.element);
    await openProject(a);
    await act(async () => void (await a.registry.execute("model.addTable", { name: "Extra" })));
    await act(async () => void (await a.registry.execute("package.open.run", { path: "C:/share/pkg1.biforge" })));
    const dlg = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(a.session.getSnapshot().viewing).toBeNull();
    fireEvent.click(within(dlg).getByRole("button", { name: "Don't save" }));
    await waitFor(() => expect(a.session.getSnapshot().viewing).not.toBeNull());
  });
});

describe("opening a shared report and deep links", () => {
  it("a biforge:// link never opens by itself: it shows what it points to, and Open then needs a click", async () => {
    const a = makeApp();
    prepareOpened(a);
    render(a.element);
    await act(async () => void (await a.registry.execute("link.open", { link: "biforge://open?src=file&path=C%3A%5Cshare%5Cpkg1.biforge" })));
    const dlg = await screen.findByRole("dialog", { name: "Open a shared report" });
    expect(dlg.textContent).toMatch(/This link came from outside BIForge/);
    expect((within(dlg).getByLabelText("Report file") as HTMLInputElement).value).toBe("C:\\share\\pkg1.biforge");
    const details = await within(dlg).findByRole("region", { name: "Package details" });
    expect(details.textContent).toMatch(/Signature: valid/);
    expect(details.textContent).toMatch(/Publisher key: AbCdEfGhIjKlMnOp/);
    expect(details.textContent).toMatch(/read-only view/);
    expect(a.session.getSnapshot().viewing).toBeNull();
    fireEvent.click(within(dlg).getByRole("button", { name: "Open for viewing" }));
    await waitFor(() => expect(a.session.getSnapshot().viewing).not.toBeNull());
  });

  it("an encrypted package asks for the access key and passes it on", async () => {
    const a = makeApp();
    prepareOpened(a, "private");
    a.publish.envelope = { ...a.publish.envelope, access: "private", encrypted: true };
    render(a.element);
    await act(async () => void (await a.registry.execute("package.open", { path: "C:/share/pkg1.biforge" })));
    const dlg = await screen.findByRole("dialog", { name: "Open a shared report" });
    await within(dlg).findByRole("region", { name: "Package details" });
    const open = within(dlg).getByRole("button", { name: "Open for viewing" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText("Access key"), { target: { value: "AGE-SECRET-KEY-1ABC" } });
    expect(open.disabled).toBe(false);
    fireEvent.click(open);
    await waitFor(() => expect(a.session.getSnapshot().viewing).not.toBeNull());
    expect(a.publish.openedWith.at(-1)).toEqual({ path: "C:/share/pkg1.biforge", key: "AGE-SECRET-KEY-1ABC" });
  });

  it("a package that fails its checks is reported and cannot be opened", async () => {
    const a = makeApp();
    render(a.element);
    await act(async () => void (await a.registry.execute("package.open", { path: "C:/share/bad.biforge" })));
    const dlg = await screen.findByRole("dialog", { name: "Open a shared report" });
    expect((await within(dlg).findByRole("alert")).textContent).toMatch(/signature is not valid/);
    expect((within(dlg).getByRole("button", { name: "Open for viewing" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("links from sources this version cannot open say so; non-links are refused", async () => {
    const a = makeApp();
    render(a.element);
    const p2p = await a.registry.execute("link.open", { link: "biforge://open?src=p2p&ticket=abc" });
    expect(!p2p.ok && p2p.message).toMatch(/cannot open it yet|cannot open yet/);
    const bad = await a.registry.execute("link.open", { link: "https://example.com" });
    expect(bad.ok).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a link or file the app was started with opens the same confirmation", async () => {
    const a = makeApp();
    prepareOpened(a);
    a.publish.startup = "C:\\Users\\ann\\Downloads\\pkg1.biforge";
    render(a.element);
    await act(async () => void (await a.registry.execute("package.startup")));
    const dlg = await screen.findByRole("dialog", { name: "Open a shared report" });
    expect((within(dlg).getByLabelText("Report file") as HTMLInputElement).value).toBe("C:\\Users\\ann\\Downloads\\pkg1.biforge");
  });
});

describe("static hosting: connect an account, publish, open by link, check for updates", () => {
  const FEED = "https://ann.github.io/site/feed.json";
  const link = "biforge://open?src=url&url=" + encodeURIComponent(FEED);

  it("asks for the data-leaving confirmation in plain words, and a token only goes to the credential store", async () => {
    const a = makeApp();
    withData(a);
    render(a.element);
    await openProject(a);
    const dlg = await openPublish(a);
    a.shell.settings.setOption("publish.guide.static-github-pages.hidden", true);
    fireEvent.click(within(dlg).getByRole("combobox", { name: "Destination type" }));
    fireEvent.click(await screen.findByRole("option", { name: /GitHub Pages/ }));
    fireEvent.change(within(dlg).getByLabelText("Destination name"), { target: { value: "My site" } });
    fireEvent.change(within(dlg).getByLabelText("Repository name"), { target: { value: "my-site" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add destination" }));
    const sec = await within(dlg).findByRole("region", { name: "Destination My site" });
    expect(sec.textContent).toMatch(/Account\s*Not connected/);
    expect(a.publish.targetsByRoot.get(ROOT)![0].settings).toEqual({ repo: "my-site" });

    // not connected: the steps and the token field are shown; a rejected token is not kept
    const connect = within(dlg).getByRole("group", { name: "Connect GitHub" });
    expect(within(connect).getByRole("list", { name: "How to get a GitHub token" }).textContent).toMatch(/Tokens \(classic\)/);
    fireEvent.change(within(connect).getByLabelText("GitHub token"), { target: { value: "bad" } });
    fireEvent.click(within(connect).getByRole("button", { name: "Connect GitHub" }));
    expect((await within(connect).findByRole("alert")).textContent).toMatch(/did not accept the token/);
    expect(a.publish.connected.has("github")).toBe(false);
    fireEvent.change(within(connect).getByLabelText("GitHub token"), { target: { value: "ghp_good" } });
    fireEvent.click(within(connect).getByRole("button", { name: "Connect GitHub" }));
    await waitFor(() => expect(within(dlg).getByText(/GitHub is connected as ann/)).toBeTruthy());
    expect(a.publish.calls).toContain("connect:github:");

    // the confirmation names the public web address
    const confirm = within(dlg).getByRole("checkbox", { name: /public web address/ });
    const publish = within(dlg).getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    fireEvent.change(within(dlg).getByLabelText("Publisher name"), { target: { value: "Ann" } });
    expect(publish.disabled).toBe(true);
    fireEvent.click(confirm);
    await waitFor(() => expect((within(dlg).getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dlg).getByRole("button", { name: "Disconnect GitHub" }));
    await waitFor(() => expect(a.publish.connected.has("github")).toBe(false));
  });

  it("a feed link downloads the package, shows who signed it, and Open then subscribes (pins the publisher)", async () => {
    const a = makeApp({ withProjectOnDisk: false });
    prepareOpened(a);
    render(a.element);
    await act(async () => {
      expect((await a.registry.execute("link.open", { link })).ok).toBe(true);
    });
    const dlg = await screen.findByRole("dialog", { name: "Open a shared report" });
    await waitFor(() => expect(within(dlg).getByRole("region", { name: "Package details" })).toBeTruthy());
    expect(a.publish.calls).toContain("fetch:" + FEED);
    expect(dlg.textContent).toContain(FEED);
    expect(dlg.textContent).toMatch(/First time: BIForge will remember this publisher key/);
    expect(a.session.getSnapshot().viewing).toBeNull(); // nothing opened by the link itself
    fireEvent.click(within(dlg).getByRole("button", { name: "Open for viewing" }));
    await waitFor(() => expect(a.session.getSnapshot().viewing?.feedUrl).toBe(FEED));
    expect(a.publish.calls.some((c) => c.startsWith("subscribe:" + FEED))).toBe(true);
    expect(a.publish.openedWith[0]).toEqual({ path: "C:\\Downloads\\pkg1.biforge", key: null });
  });

  it("Check for updates opens a newer version checked against the pinned publisher, or says it is up to date", async () => {
    const a = makeApp({ withProjectOnDisk: false });
    prepareOpened(a);
    render(a.element);
    await act(async () => {
      expect((await a.registry.execute("package.open.run", { path: "C:/share/pkg1.biforge", feedUrl: FEED })).ok).toBe(true);
    });
    const bar = await screen.findByRole("region", { name: "Viewing mode" });
    fireEvent.click(within(bar).getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(a.session.getSnapshot().lastMessage).toMatch(/is up to date \(version 4\)/));

    a.publish.newer = { path: "C:\\Downloads\\pkg1.biforge", envelope: { ...a.publish.envelope, version: 5 }, existingPin: "pinned-key" };
    a.publish.opened = { ...a.publish.opened!, manifest: { ...a.publish.opened!.manifest, version: 5 } };
    fireEvent.click(within(bar).getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(a.session.getSnapshot().viewing?.version).toBe(5));
    expect(a.publish.openedWith.at(-1)).toEqual({ path: "C:\\Downloads\\pkg1.biforge", key: null });
    expect(a.publish.calls).toContain("opened:pkg1:5");
    expect(a.session.getSnapshot().lastMessage).toMatch(/Updated "Sales report" to version 5/);
  });

  it("a report opened from a file has no update check", async () => {
    const a = makeApp({ withProjectOnDisk: false });
    prepareOpened(a);
    render(a.element);
    await act(async () => {
      await a.registry.execute("package.open.run", { path: "C:/share/pkg1.biforge" });
    });
    const bar = await screen.findByRole("region", { name: "Viewing mode" });
    expect(within(bar).queryByRole("button", { name: "Check for updates" })).toBeNull();
    const r = await a.registry.execute("subscription.check", {});
    expect(r.ok).toBe(false);
  });
});

describe("scheduled refresh on GitHub", () => {
  async function published(a: App) {
    withData(a);
    render(a.element);
    await openProject(a);
    // Sales came from a CSV file; Customer from a database server
    a.session.store.transact("sources", (p) => {
      const cols = (t: string) => Object.entries(TABLE_COLUMNS[t]).map(([name, ty]) => ({ name, duckdbType: ty, biType: ty as BiType }));
      applyImport(p, { name: "Sales", columns: cols("Sales"), rowCount: 3 }, { kind: "csv", path: "C:\data\sales.csv" });
      applyImport(p, { name: "Customer", columns: cols("Customer"), rowCount: 3 }, { kind: "postgres", host: "h", port: 5432, database: "d", user: "u", schema: "public", table: "customer" });
    });
    a.shell.settings.setOption("publish.guide.static-github-pages.hidden", true);
    a.publish.connected.add("github");
    const dlg = await openPublish(a);
    fireEvent.click(within(dlg).getByRole("combobox", { name: "Destination type" }));
    fireEvent.click(await screen.findByRole("option", { name: /GitHub Pages/ }));
    fireEvent.change(within(dlg).getByLabelText("Destination name"), { target: { value: "My site" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add destination" }));
    fireEvent.click(await within(dlg).findByRole("checkbox", { name: /public web address/ }));
    fireEvent.change(within(dlg).getByLabelText("Publisher name"), { target: { value: "Ann" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Publish" }));
    await within(dlg).findByRole("button", { name: "Publish update" });
    return dlg;
  }

  it("says where it runs, lists the whole files that go to the repository, and needs the confirmation", async () => {
    const a = makeApp();
    const dlg = await published(a);
    const sec = within(dlg).getByRole("group", { name: "Scheduled refresh" });
    expect(sec.textContent).toMatch(/on GitHub's servers/);
    expect(sec.textContent).toMatch(/Nothing on this PC has to stay on/);
    expect(sec.textContent).toMatch(/Customer: cannot be refreshed there.*database server/);
    expect(within(sec).getByRole("checkbox", { name: "Sales: C:\data\sales.csv" })).toBeTruthy();
    const turnOn = within(sec).getByRole("button", { name: "Turn on scheduled refresh" }) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
    fireEvent.click(within(sec).getByRole("checkbox", { name: /these whole files go to/ }));
    fireEvent.click(within(sec).getByRole("radio", { name: "Every week" }));
    await waitFor(() => expect((within(sec).getByRole("button", { name: "Turn on scheduled refresh" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(sec).getByRole("button", { name: "Turn on scheduled refresh" }));
    await within(sec).findByText(/Scheduled refresh is on \(weekly\)/);
    const args = a.publish.refreshArgs[0];
    expect(args.schedule).toBe("weekly");
    expect(args.confirmedSources).toEqual(["C:\data\sales.csv"]);
    expect(args.sources.map((s) => s.table)).toEqual(["Sales"]);
    fireEvent.click(within(sec).getByRole("button", { name: "Refresh now" }));
    await waitFor(() => expect(a.publish.calls.some((c) => c.startsWith("refresh-now:"))).toBe(true));
    fireEvent.click(within(sec).getByRole("button", { name: "Turn off scheduled refresh" }));
    await within(sec).findByRole("button", { name: "Turn on scheduled refresh" });
    expect(a.publish.calls.some((c) => c.startsWith("refresh-off:"))).toBe(true);
  });

  it("is offered only by destinations that can run it", async () => {
    const a = makeApp();
    withData(a);
    render(a.element);
    await openProject(a);
    const dlg = await openPublish(a);
    await addFolderTarget(a, dlg);
    fireEvent.click(await within(dlg).findByRole("checkbox", { name: /I have checked this list/ }));
    fireEvent.change(within(dlg).getByLabelText("Publisher name"), { target: { value: "Ann" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Publish" }));
    await within(dlg).findByRole("button", { name: "Publish update" });
    expect(within(dlg).queryByRole("group", { name: "Scheduled refresh" })).toBeNull();
  });
});
