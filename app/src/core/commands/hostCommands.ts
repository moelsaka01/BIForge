// Host from this PC, joining a server, and opening a server's reports for viewing. The dialogs only dispatch these ids.
import type { CommandRegistry } from "./registry";
import type { Session } from "../session/session";
import type { InviteRequest, P2pRole, RlsRole, WsRole } from "../host/types";

const hasHost = (s: Session) => s.host !== null;

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing value: ${k}.`);
  return v.trim();
};

export function registerHostCommands(r: CommandRegistry<Session>): void {
  r.register({
    id: "host.open",
    label: "Host and collaborate",
    category: "Share",
    isEnabled: hasHost,
    async run(s) {
      s.shell.openDialog({ kind: "host" });
      await s.hostUi.open();
    },
  });
  r.register({
    id: "host.start",
    label: "Turn on Host from this PC",
    category: "Share",
    isEnabled: hasHost,
    async run(s, args) {
      const a = (args ?? {}) as { lan?: boolean; port?: number | null; publicUrl?: string | null; tls?: boolean };
      await s.hostUi.startHosting(a.lan === true, a.port ?? null, a.publicUrl ?? null, a.tls !== false);
    },
  });
  r.register({ id: "host.stop", label: "Turn off Host from this PC", category: "Share", isEnabled: hasHost, run: (s) => s.hostUi.stopHosting() });
  r.register({
    id: "host.select",
    label: "Show a server or workspace",
    category: "Share",
    isEnabled: hasHost,
    run: (s, args) => {
      const a = (args ?? {}) as Args;
      return s.hostUi.select(str(a, "connection"), typeof a.workspace === "string" ? a.workspace : undefined);
    },
  });
  r.register({ id: "host.workspace.create", label: "Create a workspace", category: "Share", isEnabled: hasHost, run: (s, args) => s.hostUi.createWorkspace(str((args ?? {}) as Args, "name")) });
  r.register({
    id: "host.invite",
    label: "Invite someone",
    category: "Share",
    isEnabled: hasHost,
    run: (s, args) => {
      const a = (args ?? {}) as { role?: WsRole; identity?: string; rlsRoles?: string[]; expiresMinutes?: number };
      const req: InviteRequest = { role: a.role ?? "viewer", identity: (a.identity ?? "").trim(), rlsRoles: a.rlsRoles ?? [], expiresMinutes: a.expiresMinutes ?? 60 * 24 };
      if (!req.identity) throw new Error("Enter who the invitation is for (an e-mail address or a name). It decides which rows they see.");
      return s.hostUi.invite(req);
    },
  });
  r.register({
    id: "host.member.set",
    label: "Change a member",
    category: "Share",
    isEnabled: hasHost,
    run: (s, args) => {
      const a = (args ?? {}) as { member?: string; role?: WsRole | null; rlsRoles?: string[] | null };
      return s.hostUi.setMember(str(a as Args, "member"), a.role ?? null, a.rlsRoles ?? null);
    },
  });
  r.register({ id: "host.member.revoke", label: "Remove a member", category: "Share", isEnabled: hasHost, run: (s, args) => s.hostUi.revoke(str((args ?? {}) as Args, "member")) });
  r.register({ id: "host.versions.load", label: "Show the kept versions of a report", category: "Share", isEnabled: hasHost, run: (s, args) => s.hostUi.loadVersions(str((args ?? {}) as Args, "report")) });
  r.register({
    id: "host.version.restore",
    label: "Make an older version of a report current",
    category: "Share",
    isEnabled: hasHost,
    run: (s, args) => {
      const a = (args ?? {}) as { report?: string; version?: number };
      if (typeof a.version !== "number") throw new Error("Missing value: version.");
      return s.hostUi.restoreVersion(str(a as Args, "report"), a.version);
    },
  });
  r.register({ id: "host.roles.load", label: "Show the data roles of a report", category: "Share", isEnabled: hasHost, run: (s, args) => s.hostUi.loadRoles(str((args ?? {}) as Args, "report")) });
  r.register({
    id: "host.roles.save",
    label: "Save the data roles of a report",
    category: "Share",
    isEnabled: hasHost,
    run: (s, args) => {
      const a = (args ?? {}) as { report?: string; roles?: RlsRole[] };
      return s.hostUi.saveRoles(str(a as Args, "report"), a.roles ?? []);
    },
  });
  r.register({ id: "host.report.delete", label: "Remove a report from the server", category: "Share", isEnabled: hasHost, run: (s, args) => s.hostUi.deleteReport(str((args ?? {}) as Args, "report")) });

  // ---- direct sessions (peer to peer) ----
  r.register({ id: "p2p.host.refresh", label: "Refresh the direct session", category: "Share", isEnabled: hasHost, run: (s, args) => s.hostUi.p2pRefreshHost(str((args ?? {}) as Args, "target")) });
  r.register({
    id: "p2p.approve",
    label: "Accept a guest of the direct session",
    category: "Share",
    isEnabled: hasHost,
    run: (s, args) => {
      const a = (args ?? {}) as { target?: string; request?: number; role?: P2pRole };
      if (typeof a.request !== "number") throw new Error("Missing value: request.");
      if (a.role !== "readOnly" && a.role !== "edit") throw new Error("Choose read-only or edit.");
      return s.hostUi.p2pApprove(str(a as Args, "target"), a.request, a.role);
    },
  });
  r.register({
    id: "p2p.deny",
    label: "Refuse a guest of the direct session",
    category: "Share",
    isEnabled: hasHost,
    run: (s, args) => {
      const a = (args ?? {}) as { target?: string; request?: number };
      if (typeof a.request !== "number") throw new Error("Missing value: request.");
      return s.hostUi.p2pDeny(str(a as Args, "target"), a.request);
    },
  });
  r.register({
    id: "p2p.revoke",
    label: "End a guest's access to the direct session",
    category: "Share",
    isEnabled: hasHost,
    run: (s, args) => {
      const a = (args ?? {}) as Args;
      return s.hostUi.p2pRevoke(str(a, "target"), str(a, "endpoint"));
    },
  });
  r.register({
    id: "p2p.push.take",
    label: "Save a copy a guest sent",
    category: "Share",
    isEnabled: hasHost,
    async run(s, args) {
      const a = (args ?? {}) as { target?: string; push?: number };
      if (typeof a.push !== "number") throw new Error("Missing value: push.");
      await s.hostUi.p2pTakePush(str(a as Args, "target"), a.push);
    },
  });
  r.register({
    id: "p2p.join.run",
    label: "Join a direct session with a pairing code",
    category: "File",
    isEnabled: hasHost,
    async run(s, args) {
      const a = (args ?? {}) as { code?: string; name?: string };
      const ok = await s.hostUi.p2pJoin(str(a as Args, "code"), a.name ?? "");
      if (!ok) throw new Error(s.hostUi.getSnapshot().error ?? "Could not join.");
    },
  });
  r.register({ id: "p2p.leave", label: "Leave the direct session", category: "File", isEnabled: hasHost, run: (s) => s.hostUi.p2pLeave() });
  r.register({
    id: "p2p.guest.push",
    label: "Send my copy to the host",
    category: "File",
    isEnabled: (s) => hasHost(s) && s.getSnapshot().viewing?.p2p?.role === "edit",
    async run(s) {
      const path = await s.dialogs.pickFile("BIForge package", ["biforge"]);
      if (path) await s.hostUi.p2pPush(path);
    },
  });

  // ---- joining ----
  r.register({
    id: "server.join",
    label: "Join a server",
    category: "File",
    isEnabled: hasHost,
    run: (s, args) => {
      const a = (args ?? {}) as { link?: string; invite?: string };
      s.shell.openDialog({ kind: "joinServer", link: a.link, invite: a.invite });
    },
  });
  r.register({
    id: "server.join.run",
    label: "Join with the invitation",
    category: "File",
    isEnabled: hasHost,
    async run(s, args) {
      const a = (args ?? {}) as { link?: string; invite?: string; name?: string; pin?: string };
      const conn = await s.hostUi.join(str(a as Args, "link"), a.invite?.trim() || null, a.name ?? "", a.pin?.trim() || null);
      if (conn) {
        s.setMessage(`Joined "${conn.workspaceName}" as ${conn.role}. You can open its reports from Host and collaborate.`);
        s.shell.closeDialog();
      } else {
        throw new Error(s.hostUi.getSnapshot().error ?? "Could not join.");
      }
    },
  });
  r.register({
    id: "server.connectAdmin",
    label: "Sign in to a server as its administrator",
    category: "File",
    isEnabled: hasHost,
    async run(s, args) {
      const a = (args ?? {}) as { url?: string; token?: string; pin?: string };
      const conn = await s.hostUi.connectAdmin(a.url ?? "", a.token ?? "", a.pin ?? null);
      if (!conn) throw new Error(s.hostUi.getSnapshot().error ?? "Could not sign in.");
      s.setMessage(`Signed in to ${conn.url} as its administrator.`);
      s.shell.closeDialog();
      s.shell.openDialog({ kind: "host" });
    },
  });
  r.register({ id: "server.forget", label: "Forget a server", category: "File", isEnabled: hasHost, run: (s, args) => s.hostUi.forget(str((args ?? {}) as Args, "id")) });
  r.register({
    id: "server.report.open",
    label: "Open a server report for viewing",
    category: "File",
    isEnabled: hasHost,
    async run(s, args) {
      const a = (args ?? {}) as { connection?: string; workspace?: string; report?: string; discard?: boolean };
      if (s.store.getSnapshot().isDirty && a.discard !== true) {
        s.shell.openDialog({ kind: "unsaved", resume: { id: "server.report.open", args: { ...a, discard: true } } });
        return;
      }
      if (s.store.getSnapshot().isDirty) await s.discardUnsavedForExit().catch(() => undefined);
      const opened = await s.host!.openReport(str(a as Args, "connection"), a.workspace ?? null, str(a as Args, "report"));
      await s.openServerViewing(opened);
      s.shell.closeDialog();
    },
  });
}
