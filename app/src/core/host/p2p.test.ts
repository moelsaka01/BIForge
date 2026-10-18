import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegistry } from "../commands/builtin";
import { fixtureProject } from "../report/testFixture";
import { Session } from "../session/session";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { FakeHost } from "../testing/fakeHost";
import { FakePublish } from "../testing/fakePublish";
import type { OpenedPackage } from "../publish/types";

const ROOT = "C:/cache/p2p";

function setup() {
  const io = new FakeIO();
  const host = new FakeHost();
  const publish = new FakePublish();
  const session = new Session(io, new FakeDialogs(), null, null, undefined, publish, host);
  io.disk.set(ROOT, fixtureProject());
  const opened: OpenedPackage = {
    root: ROOT,
    pbipPath: `${ROOT}/Fixture.pbip`,
    manifest: { formatVersion: 1, packageId: "pkg1", version: 1, reportName: "Shared", publisher: { name: "Host", keyId: "k1", publicKey: "PUB" }, access: "public", included: [], createdAt: "t", rlsEnforced: false },
    dataFiles: [],
  };
  publish.opened = opened;
  return { io, host, publish, session, registry: createRegistry(session) };
}

afterEach(() => vi.useRealTimers());

describe("direct sessions: host side", () => {
  it("shows the code, accepts a guest with a role, ends access and saves a copy a guest sent", async () => {
    const { host, registry, session } = setup();
    expect((await registry.execute("p2p.host.refresh", { target: "t1" })).ok).toBe(true);
    const v = session.hostUi.getSnapshot().p2pHosts.t1;
    expect(v.code).toMatch(/^BF1-/);
    expect(v.pending.map((p) => p.name)).toEqual(["Zoe"]);
    // the role must be chosen; nothing is accepted by default
    expect((await registry.execute("p2p.approve", { target: "t1", request: 1 })).ok).toBe(false);
    expect((await registry.execute("p2p.approve", { target: "t1", request: 1, role: "readOnly" })).ok).toBe(true);
    expect(host.p2pCalls).toContain("approve:t1:1:readOnly");
    expect(session.hostUi.getSnapshot().p2pHosts.t1.peers[0]).toMatchObject({ name: "Zoe", role: "readOnly", connected: true });
    await registry.execute("p2p.revoke", { target: "t1", endpoint: "e1" });
    expect(session.hostUi.getSnapshot().p2pHosts.t1.peers[0].revoked).toBe(true);
    await registry.execute("p2p.push.take", { target: "t1", push: 7 });
    expect(host.p2pCalls).toContain("take:t1:7");
    expect(session.getSnapshot().lastMessage).toMatch(/Saved the copy to C:\/incoming\/zoe-1\.biforge/);
  });
});

describe("direct sessions: guest side", () => {
  it("waits for the host, opens the shared report in viewing mode when it arrives, follows the next version, and ends with the host", async () => {
    vi.useFakeTimers();
    const { host, publish, registry, session } = setup();
    expect((await registry.execute("p2p.join.run", { code: "BF1-abc-0123456789", name: "Ann" })).ok).toBe(true);
    expect(host.p2pCalls).toContain("join:BF1-abc-0123456789:Ann");
    expect(session.hostUi.getSnapshot().p2pGuest?.view?.state).toBe("waiting");
    expect(session.getSnapshot().viewing).toBeNull();

    // the host approves with the edit role and the package arrives
    host.p2pGuest = { state: "approved", reason: "", role: "edit", hostId: "hostid-0123456789", newPackage: { version: 1, path: "C:/guest/g_1-v1.biforge" }, message: null };
    await vi.advanceTimersByTimeAsync(1600);
    expect(publish.openedWith.at(-1)).toEqual({ path: "C:/guest/g_1-v1.biforge", key: null });
    const v = session.getSnapshot().viewing;
    expect(v?.reportName).toBe("Shared");
    expect(v?.p2p).toEqual({ guestId: "g_1", role: "edit", hostId: "hostid-0123456789" });
    expect(session.hostUi.getSnapshot().p2pGuest?.pin).toBe("PUB");

    // a live update opens again, pinned to the first publisher key
    host.p2pGuest = { ...host.p2pGuest, newPackage: { version: 2, path: "C:/guest/g_1-v2.biforge" } };
    await vi.advanceTimersByTimeAsync(1600);
    expect(publish.openedWith.at(-1)).toEqual({ path: "C:/guest/g_1-v2.biforge", key: null });

    // the edit role can send a copy; a read-only guest cannot (the command is disabled)
    expect(registry.isEnabled("p2p.guest.push")).toBe(true);

    // the host stops the session: the window says so and stops polling
    host.p2pGuest = { ...host.p2pGuest, state: "ended", reason: "The host ended your access.", newPackage: null };
    await vi.advanceTimersByTimeAsync(1600);
    expect(session.getSnapshot().lastMessage).toMatch(/The direct session ended: The host ended your access\./);
    const calls = host.p2pCalls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.p2pCalls.length).toBe(calls);
    await registry.execute("p2p.leave");
    expect(host.p2pCalls).toContain("leave:g_1");
  });

  it("shows the host's refusal and stops polling", async () => {
    vi.useFakeTimers();
    const { host, registry, session } = setup();
    host.p2pGuest = { state: "denied", reason: "The host did not accept your request.", role: "readOnly", hostId: "h", newPackage: null, message: null };
    await registry.execute("p2p.join.run", { code: "BF1-abc-0123456789", name: "Eve" });
    expect(session.hostUi.getSnapshot().p2pGuest?.view).toMatchObject({ state: "denied", reason: "The host did not accept your request." });
    expect(session.getSnapshot().viewing).toBeNull();
  });

  it("a name is required, and a read-only viewer cannot send a copy", async () => {
    const { host, registry } = setup();
    expect((await registry.execute("p2p.join.run", { code: "BF1-abc-0123456789", name: " " })).ok).toBe(false);
    expect(host.p2pCalls.some((c) => c.startsWith("join:"))).toBe(false);
    expect(registry.isEnabled("p2p.guest.push")).toBe(false);
  });
});
