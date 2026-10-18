import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "../commands/builtin";
import { Session } from "../session/session";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { FakeHost } from "../testing/fakeHost";
import { FakePublish, fakeGithubAdapter } from "../testing/fakePublish";
import { guideForAdapter } from "./guides";
import type { AdapterInfo } from "./types";

const drive: AdapterInfo = {
  ...fakeGithubAdapter,
  id: "google-drive",
  name: "Google Drive",
  method: "personalStorage",
  phase: "O3",
  capabilities: { ...fakeGithubAdapter.capabilities, scheduledRefresh: false, versionHistory: true },
  limitations: ["Shares the editable project snapshot, not a live dashboard"],
  freeTier: ["Free Google account, 15 GB shared with Gmail and Photos"],
};

async function setup() {
  const io = new FakeIO();
  const publish = new FakePublish();
  publish.adapterList = [drive];
  const session = new Session(io, new FakeDialogs(), null, null, undefined, publish, new FakeHost());
  await session.newProject("C:/proj", "Proj");
  const registry = createRegistry(session);
  return { io, publish, session, registry };
}

afterEach(() => vi.useRealTimers());

describe("personal storage in the app (fakes)", () => {
  it("the guide for each provider has a real Connect step, not a placeholder", () => {
    for (const id of ["google-drive", "onedrive", "dropbox"]) {
      const g = guideForAdapter(id)!;
      expect(g.buttons.some((b) => b.action.kind === "connectStorage" && b.action.provider === id)).toBe(true);
      expect(g.buttons.every((b) => b.action.kind !== "notImplemented")).toBe(true);
    }
  });

  it("connects through the browser: opens the sign-in address, waits for the answer, shows the account, disconnects", async () => {
    vi.useFakeTimers();
    const { io, publish, session, registry } = await setup();
    const opened: string[] = [];
    io.openUrl = async (u: string) => void opened.push(u);
    expect((await registry.execute("storage.connect", { provider: "nope" })).ok).toBe(false);
    expect((await registry.execute("storage.connect", { provider: "google-drive" })).ok).toBe(true);
    expect(opened).toEqual(["https://accounts.example/google-drive/authorize?state=abc"]);
    expect(session.publishUi.getSnapshot().storage["google-drive"]).toMatchObject({ pending: true, connected: false });
    // the browser answered
    publish.storageStatus = { state: "done", account: "ann@example.com", message: null };
    publish.storage["google-drive"] = { connected: true, account: "ann@example.com" };
    await vi.advanceTimersByTimeAsync(1600);
    expect(session.publishUi.getSnapshot().storage["google-drive"]).toMatchObject({ connected: true, account: "ann@example.com", pending: false });
    expect(session.getSnapshot().lastMessage).toMatch(/Connected google-drive as ann@example.com/);
    await registry.execute("storage.disconnect", { provider: "google-drive" });
    expect(publish.calls).toContain("storage-disconnect:google-drive");
    expect(session.publishUi.getSnapshot().storage["google-drive"].connected).toBe(false);
  });

  it("a refused or abandoned sign-in shows the reason and stops waiting", async () => {
    vi.useFakeTimers();
    const { io, publish, session, registry } = await setup();
    io.openUrl = async () => undefined;
    await registry.execute("storage.connect", { provider: "dropbox" });
    publish.storageStatus = { state: "error", account: null, message: "The sign-in was refused: access_denied" };
    await vi.advanceTimersByTimeAsync(1600);
    expect(session.publishUi.getSnapshot().storage.dropbox).toMatchObject({ connected: false, pending: false, message: "The sign-in was refused: access_denied" });
    const n = publish.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(publish.calls.length).toBe(n);
  });

  it("history, sharing with a person, and the overwrite choice after a conflict", async () => {
    const { publish, session, registry } = await setup();
    await registry.execute("publish.open");
    await registry.execute("publish.addTarget", { adapterId: "google-drive", label: "Drive", access: "public", settings: {} });
    const id = session.publishUi.getSnapshot().selected!;
    await registry.execute("publish.versions");
    expect(session.publishUi.getSnapshot().versions?.map((v) => v.id)).toEqual(["r2", "r1"]);
    expect((await registry.execute("publish.shareWith", { email: "not an address" })).ok).toBe(false);
    expect((await registry.execute("publish.shareWith", { email: "bob@example.com", canEdit: true })).ok).toBe(true);
    expect(publish.calls).toContain(`share-with:${id}:bob@example.com:edit`);

    // a conflict is reported, offers Overwrite, and Overwrite allows the next upload only
    publish.conflict = true;
    const ui = session.publishUi;
    // the tables that can be published come from the data engine in the app; here they are given directly
    const chosen = [{ table: "Sales", columns: ["Amount"] }];
    (ui as unknown as { set(p: object): void }).set({ available: chosen, chosen });
    ui.confirmShown(true);
    await expect(ui.publish("Ann")).rejects.toThrow(/changed by someone else/);
    expect(ui.getSnapshot().conflict).toBe(true);
    expect(ui.getSnapshot().error).toMatch(/Choose Overwrite/);
    ui.confirmShown(true);
    await registry.execute("publish.overwrite", { publisherName: "Ann" });
    expect(publish.calls).toContain(`overwrite:${id}`);
    expect(ui.getSnapshot().conflict).toBe(false);
    expect(publish.runs.length).toBeGreaterThan(0);
  });
});
