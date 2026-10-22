// State and logic of the "Host & Collaborate" and "Join a server" dialogs. Components render this and dispatch
// commands (core/commands/hostCommands.ts); the commands call these methods.
import type { Session } from "../session/session";
import type { AuditEntry, Connection, HostApi, HostStatus, InviteInfo, InviteRequest, Member, P2pGuestView, P2pHostView, P2pRole, RlsRole, ServerReport, VersionInfo, Workspace, WsRole } from "./types";

/** A direct (peer to peer) session this window joined as a guest. */
export interface P2pGuest {
  id: string;
  name: string;
  view: P2pGuestView | null;
  /** The publisher key of the first package; later versions must come from the same key. */
  pin: string | null;
  /** A package that arrived while another project had unsaved changes. */
  pendingPath: string | null;
}

export interface HostState {
  loaded: boolean;
  status: HostStatus;
  connections: Connection[];
  /** The connection the panels below show. */
  selected: string | null;
  workspaces: Workspace[];
  workspace: string | null;
  members: Member[];
  reports: ServerReport[];
  audit: AuditEntry[];
  roles: { report: string; roles: RlsRole[] } | null;
  /** The kept versions of one report (version history). */
  versions: { report: string; list: VersionInfo[] } | null;
  /** The invite just made (shown once; the link is what to send). */
  invite: InviteInfo | null;
  /** Direct sessions: host side per publication target, and the one this window joined. */
  p2pHosts: Record<string, P2pHostView>;
  p2pGuest: P2pGuest | null;
  busy: boolean;
  error: string | null;
}

const NO_HOST: HostStatus = { running: false, url: "", fingerprint: null, adminToken: null, lan: false };
const EMPTY: HostState = { loaded: false, status: NO_HOST, connections: [], selected: null, workspaces: [], workspace: null, members: [], reports: [], audit: [], roles: null, versions: null, invite: null, p2pHosts: {}, p2pGuest: null, busy: false, error: null };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class HostUi {
  private snap: HostState = EMPTY;
  private listeners = new Set<() => void>();

  constructor(private readonly session: Session) {}

  getSnapshot = (): HostState => this.snap;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<HostState>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  private get api(): HostApi {
    if (!this.session.host) throw new Error("Hosting and joining need the BIForge app window.");
    return this.session.host;
  }

  private async guard<T>(f: () => Promise<T>): Promise<T | undefined> {
    this.set({ busy: true, error: null });
    try {
      return await f();
    } catch (e) {
      this.set({ error: errText(e) });
      return undefined;
    } finally {
      this.set({ busy: false });
    }
  }

  /** Loads the host status and the connections; shows the first server. */
  async open(): Promise<void> {
    await this.guard(() => this.reload());
  }

  private async reload(): Promise<void> {
    const [status, connections] = await Promise.all([this.api.status(), this.api.connections()]);
    const selected = this.snap.selected && connections.some((c) => c.id === this.snap.selected) ? this.snap.selected : (connections[0]?.id ?? null);
    this.set({ loaded: true, status, connections, selected, invite: null });
    if (selected) await this.loadServer(selected);
    else this.set({ workspaces: [], workspace: null, members: [], reports: [], audit: [], roles: null });
  }

  private async loadServer(connection: string): Promise<void> {
    const conn = this.snap.connections.find((c) => c.id === connection);
    const workspaces = await this.api.op<Workspace[]>(connection, "workspaces", {});
    const want = conn?.workspaceId || this.snap.workspace;
    const workspace = workspaces.find((w) => w.id === want)?.id ?? workspaces[0]?.id ?? null;
    this.set({ selected: connection, workspaces, workspace, members: [], reports: [], audit: [], roles: null, versions: null });
    if (workspace) await this.loadWorkspace(connection, workspace);
  }

  private async loadWorkspace(connection: string, workspace: string): Promise<void> {
    const conn = this.snap.connections.find((c) => c.id === connection);
    const admin = conn?.role === "admin";
    const reports = await this.api.op<ServerReport[]>(connection, "reports", { workspace });
    const members = admin ? await this.api.op<Member[]>(connection, "members", { workspace }) : [];
    const audit = admin ? await this.api.op<AuditEntry[]>(connection, "audit", { workspace }) : [];
    this.set({ workspace, reports, members, audit });
  }

  async select(connection: string, workspace?: string): Promise<void> {
    await this.guard(async () => {
      if (workspace) {
        this.set({ selected: connection, roles: null });
        await this.loadWorkspace(connection, workspace);
      } else {
        await this.loadServer(connection);
      }
    });
  }

  async startHosting(lan: boolean, port: number | null, publicUrl: string | null, tls = true): Promise<void> {
    await this.guard(async () => {
      const status = await this.api.start(lan, port, publicUrl, tls);
      this.set({ status });
      await this.reload();
    });
  }

  async stopHosting(): Promise<void> {
    await this.guard(async () => {
      await this.api.stop();
      await this.reload();
    });
  }

  async createWorkspace(name: string): Promise<void> {
    await this.guard(async () => {
      const conn = this.requireConn();
      const ws = await this.api.op<Workspace>(conn, "createWorkspace", { name });
      await this.loadServer(conn);
      await this.loadWorkspace(conn, ws.id);
    });
  }

  async invite(req: InviteRequest): Promise<void> {
    await this.guard(async () => {
      const conn = this.requireConn();
      const invite = await this.api.op<InviteInfo>(conn, "invite", { workspace: this.requireWs(), request: req });
      await this.loadWorkspace(conn, this.requireWs());
      this.set({ invite });
    });
  }

  async setMember(member: string, role: WsRole | null, rlsRoles: string[] | null): Promise<void> {
    await this.guard(async () => {
      const conn = this.requireConn();
      await this.api.op(conn, "setMember", { workspace: this.requireWs(), member, role, rlsRoles });
      await this.loadWorkspace(conn, this.requireWs());
    });
  }

  async revoke(member: string): Promise<void> {
    await this.guard(async () => {
      const conn = this.requireConn();
      await this.api.op(conn, "revoke", { workspace: this.requireWs(), member });
      await this.loadWorkspace(conn, this.requireWs());
    });
  }

  async loadRoles(report: string): Promise<void> {
    await this.guard(async () => {
      const roles = await this.api.op<RlsRole[]>(this.requireConn(), "roles", { workspace: this.requireWs(), report });
      this.set({ roles: { report, roles } });
    });
  }

  async saveRoles(report: string, roles: RlsRole[]): Promise<void> {
    await this.guard(async () => {
      const conn = this.requireConn();
      await this.api.op(conn, "setRoles", { workspace: this.requireWs(), report, roles });
      await this.loadWorkspace(conn, this.requireWs());
      this.set({ roles: { report, roles } });
    });
  }

  async loadVersions(report: string): Promise<void> {
    await this.guard(async () => {
      const list = await this.api.op<VersionInfo[]>(this.requireConn(), "versions", { workspace: this.requireWs(), report });
      this.set({ versions: { report, list } });
    });
  }

  async restoreVersion(report: string, version: number): Promise<void> {
    await this.guard(async () => {
      const conn = this.requireConn();
      await this.api.op(conn, "restoreVersion", { workspace: this.requireWs(), report, version });
      const list = await this.api.op<VersionInfo[]>(conn, "versions", { workspace: this.requireWs(), report });
      await this.loadWorkspace(conn, this.requireWs());
      this.set({ versions: { report, list } });
    });
  }

  async deleteReport(report: string): Promise<void> {
    await this.guard(async () => {
      const conn = this.requireConn();
      await this.api.op(conn, "deleteReport", { workspace: this.requireWs(), report });
      await this.loadWorkspace(conn, this.requireWs());
      this.set({ roles: null });
    });
  }

  async connectAdmin(url: string, adminToken: string, pin: string | null): Promise<Connection | undefined> {
    return this.guard(async () => {
      if (!url.trim() || !adminToken.trim()) throw new Error("Enter the server address and its admin token.");
      const conn = await this.api.connectAdmin(url.trim(), adminToken.trim(), pin?.trim() || null);
      const connections = await this.api.connections();
      this.set({ connections, selected: conn.id });
      await this.loadServer(conn.id);
      return conn;
    });
  }

  async join(linkOrUrl: string, invite: string | null, displayName: string, pin: string | null = null): Promise<Connection | undefined> {
    return this.guard(async () => {
      if (!displayName.trim()) throw new Error("Enter your name.");
      const conn = await this.api.join(linkOrUrl, invite, displayName.trim(), pin);
      const connections = await this.api.connections();
      this.set({ connections, selected: conn.id });
      return conn;
    });
  }

  async forget(id: string): Promise<void> {
    await this.guard(async () => {
      await this.api.forget(id);
      await this.reload();
    });
  }

  // ---- direct sessions (peer to peer) ----

  async p2pRefreshHost(target: string): Promise<void> {
    try {
      const view = await this.api.p2pHostState(target);
      this.set({ p2pHosts: { ...this.snap.p2pHosts, [target]: view } });
    } catch (e) {
      this.set({ error: errText(e) });
    }
  }

  async p2pApprove(target: string, request: number, role: P2pRole): Promise<void> {
    await this.guard(async () => {
      await this.api.p2pApprove(target, request, role);
      await this.p2pRefreshHost(target);
    });
  }

  async p2pDeny(target: string, request: number): Promise<void> {
    await this.guard(async () => {
      await this.api.p2pDeny(target, request);
      await this.p2pRefreshHost(target);
    });
  }

  async p2pRevoke(target: string, endpointId: string): Promise<void> {
    await this.guard(async () => {
      await this.api.p2pRevoke(target, endpointId);
      await this.p2pRefreshHost(target);
    });
  }

  /** Saves a copy a guest sent; the host opens the file like any shared report. */
  async p2pTakePush(target: string, push: number): Promise<string | undefined> {
    return this.guard(async () => {
      const path = await this.api.p2pTakePush(target, push);
      this.session.setMessage(`Saved the copy to ${path}. Open it with Open shared report.`);
      await this.p2pRefreshHost(target);
      return path;
    });
  }

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  /** Joins a direct session. The host still has to approve; the window polls and opens the report when it arrives. */
  async p2pJoin(code: string, name: string): Promise<boolean> {
    const id = await this.guard(async () => {
      if (!name.trim()) throw new Error("Enter your name.");
      if (this.snap.p2pGuest) await this.p2pLeave();
      return this.api.p2pJoin(code.trim(), name.trim());
    });
    if (!id) return false;
    this.set({ p2pGuest: { id, name: name.trim(), view: null, pin: null, pendingPath: null } });
    this.pollTimer = setInterval(() => void this.p2pPollGuest(), 1500);
    await this.p2pPollGuest();
    return true;
  }

  /** One look at the guest session: shows the state, opens a package that arrived (first version or live update). */
  async p2pPollGuest(): Promise<void> {
    const g = this.snap.p2pGuest;
    if (!g || this.polling) return;
    this.polling = true;
    try {
      const view = await this.api.p2pGuestState(g.id);
      let pendingPath = g.pendingPath;
      if (view.newPackage) pendingPath = view.newPackage.path;
      this.set({ p2pGuest: { ...g, view, pendingPath } });
      if (pendingPath) {
        if (this.session.store.getSnapshot().isDirty && !this.session.getSnapshot().viewing) {
          this.set({ error: "Your open project has unsaved changes. Save or close it, and the shared report opens by itself." });
        } else {
          const publish = this.session.publish;
          if (!publish) throw new Error("Opening a shared report needs the BIForge app window.");
          const opened = await publish.openPackage(pendingPath, null, g.pin);
          await this.session.openViewing(opened, null, { guestId: g.id, role: view.role, hostId: view.hostId });
          this.set({ error: null, p2pGuest: { ...(this.snap.p2pGuest ?? g), view, pin: opened.manifest.publisher.publicKey, pendingPath: null } });
          this.session.shell.closeDialog();
        }
      }
      if (view.message) this.session.setMessage(view.message);
      if (view.state === "denied" || view.state === "ended") {
        this.stopTimer();
        if (view.state === "ended") this.session.setMessage(`The direct session ended: ${view.reason}`);
      }
      // the window moved to another document: the session is no longer in use
      const viewing = this.session.getSnapshot().viewing;
      if (this.snap.p2pGuest && view.state === "approved" && !pendingPath && !viewing?.p2p) await this.p2pLeave();
    } catch (e) {
      this.set({ error: errText(e) });
    } finally {
      this.polling = false;
    }
  }

  private stopTimer(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async p2pLeave(): Promise<void> {
    const g = this.snap.p2pGuest;
    this.stopTimer();
    this.set({ p2pGuest: null });
    if (g) await this.api.p2pLeave(g.id).catch(() => undefined);
  }

  /** Edit role: sends a package file (made with Publish & Share to a folder) to the host. */
  async p2pPush(path: string): Promise<void> {
    await this.guard(async () => {
      const g = this.snap.p2pGuest;
      if (!g) throw new Error("There is no direct session.");
      await this.api.p2pPush(g.id, path);
      this.session.setMessage("Sent your copy to the host. The host decides what to do with it.");
    });
  }

  clearInvite(): void {
    this.set({ invite: null });
  }

  setError(error: string | null): void {
    this.set({ error });
  }

  private requireConn(): string {
    if (!this.snap.selected) throw new Error("Choose a server first.");
    return this.snap.selected;
  }
  private requireWs(): string {
    if (!this.snap.workspace) throw new Error("Create or choose a workspace first.");
    return this.snap.workspace;
  }
}
