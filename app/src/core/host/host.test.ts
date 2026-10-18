import { describe, expect, it } from "vitest";
import { createRegistry } from "../commands/builtin";
import { viewingGuard } from "../commands/publishCommands";
import { Session } from "../session/session";
import { FakeDialogs, FakeIO } from "../testing/fakes";
import { FakeDax } from "../testing/fakeDax";
import { routedDax } from "./remoteDax";
import { FakeHost } from "../testing/fakeHost";

function setup() {
  const io = new FakeIO();
  const host = new FakeHost();
  const session = new Session(io, new FakeDialogs(), null, null, undefined, null, host);
  io.disk.set("C:/cache/s", structuredClone(io.disk.get("C:/x") ?? ({ name: "Sales" } as never)));
  return { io, host, session, registry: createRegistry(session) };
}

describe("host and collaborate", () => {
  it("turns hosting on, makes a workspace invitation and lists members, reports and the activity log", async () => {
    const { host, registry, session } = setup();
    expect((await registry.execute("host.open")).ok).toBe(true);
    expect(session.shell.getSnapshot().dialog).toEqual({ kind: "host" });
    expect((await registry.execute("host.start", { lan: false })).ok).toBe(true);
    const st = session.hostUi.getSnapshot();
    expect(st.status.running).toBe(true);
    expect(st.selected).toBe("host");
    expect(st.workspaces).toEqual([{ id: "w_1", name: "Team" }]);
    expect(st.members[0].identity).toBe("ann@x.com");
    expect(st.reports[0].hasRoles).toBe(true);
    expect(st.audit).toHaveLength(1);

    // an invitation needs the person's identity, because data roles compare with it
    const none = await registry.execute("host.invite", { role: "viewer", identity: "  " });
    expect(none.ok).toBe(false);
    expect((await registry.execute("host.invite", { role: "viewer", identity: "ann@x.com", rlsRoles: ["Mine"] })).ok).toBe(true);
    expect(host.calls.find((c) => c.op === "invite")?.args).toMatchObject({ workspace: "w_1", request: { role: "viewer", identity: "ann@x.com", rlsRoles: ["Mine"], expiresMinutes: 1440 } });
    expect(session.hostUi.getSnapshot().invite?.link).toContain("src=server");
    await registry.execute("host.member.revoke", { member: "m_1" });
    expect(host.calls.some((c) => c.op === "revoke" && c.args.member === "m_1")).toBe(true);
    await registry.execute("host.stop");
    expect(session.hostUi.getSnapshot().status.running).toBe(false);
  });

  it("joins with an invitation link and a name, and reports a missing name or code", async () => {
    const { registry, session } = setup();
    expect((await registry.execute("server.join", { link: "biforge://open?src=server&url=u&invite=i" })).ok).toBe(true);
    expect(session.shell.getSnapshot().dialog).toMatchObject({ kind: "joinServer" });
    const noName = await registry.execute("server.join.run", { link: "biforge://x", name: "" });
    expect(noName.ok).toBe(false);
    const noCode = await registry.execute("server.join.run", { link: "http://127.0.0.1:7878", name: "Ann" });
    expect(noCode.ok).toBe(false);
    expect((await registry.execute("server.join.run", { link: "biforge://open?src=server&url=u&invite=i", name: "ann" })).ok).toBe(true);
    expect(session.hostUi.getSnapshot().connections.some((c) => c.identity === "ann@x.com")).toBe(true);
    expect(session.shell.getSnapshot().dialog).toBeNull();
  });

  it("sends the queries of a server report to the server and keeps local queries local", async () => {
    const { host, session } = setup();
    const localDax = new FakeDax();
    localDax.answers.push({ match: "x", outcome: { results: [], elapsedMs: 0 } });
    const dax = routedDax(session, localDax);
    const local = await dax.query([], "EVALUATE ROW(\"x\", 1)");
    expect(host.calls.filter((c) => c.op === "query")).toHaveLength(0);
    expect(local.results).toEqual([]);
    expect(localDax.calls.length).toBeGreaterThan(0);
    // pretend a server report is open
    (session as unknown as { snap: { viewing: unknown } }).snap = {
      ...session.getSnapshot(),
      viewing: { server: { connectionId: "c_1", workspaceId: "w_1", reportId: "sales", role: "viewer", identity: "ann@x.com", serverLabel: "Team" } },
    };
    const remote = await dax.query([], "EVALUATE ROW(\"t\", [Total])");
    expect(remote.results[0].rows[0][0].v).toBe("40");
    expect(host.calls.find((c) => c.op === "query")).toMatchObject({ connection: "c_1", args: { workspace: "w_1", report: "sales" } });
  });

  it("host and join commands stay available while a report is open for viewing", () => {
    const { session } = setup();
    const viewing = { getSnapshot: () => ({ viewing: {} }) } as unknown as Session;
    for (const id of ["host.open", "host.invite", "server.join.run", "server.report.open"]) expect(viewingGuard(viewing, id), id).toBeNull();
    expect(session.host).not.toBeNull();
  });
});
