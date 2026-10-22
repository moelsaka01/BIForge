import type { Connection, HostApi, HostStatus, OpenedServerReport, P2pGuestView, P2pHostView, P2pRole } from "../host/types";

export const hostConn: Connection = { id: "host", label: "This PC (host)", url: "http://127.0.0.1:7878", workspaceId: "", workspaceName: "", role: "admin", identity: "server admin", isHost: true };

export class FakeHost implements HostApi {
  calls: { op: string; args: Record<string, unknown>; connection: string }[] = [];
  running = false;
  joined: Connection[] = [];
  async status(): Promise<HostStatus> {
    return { running: this.running, url: this.running ? hostConn.url : "", fingerprint: null, adminToken: null, lan: false };
  }
  async start(): Promise<HostStatus> {
    this.running = true;
    return this.status();
  }
  async stop(): Promise<void> {
    this.running = false;
  }
  async join(_link: string, invite: string | null, name: string): Promise<Connection> {
    if (!invite && !_link.startsWith("biforge://")) throw new Error("Enter the invitation code.");
    const c: Connection = { id: "c_1", label: `Team on ${hostConn.url}`, url: hostConn.url, workspaceId: "w_1", workspaceName: "Team", role: "viewer", identity: `${name}@x.com`, isHost: false };
    this.joined.push(c);
    return c;
  }
  async connectAdmin(url: string, _token: string, pin: string | null): Promise<Connection> {
    if (url.startsWith("https://") && !pin) throw new Error("https needs the certificate fingerprint");
    const c: Connection = { id: "c_admin", label: `Admin of ${url}`, url, workspaceId: "", workspaceName: "", role: "admin", identity: "server admin", isHost: false, pin };
    this.joined.push(c);
    return c;
  }
  async connections(): Promise<Connection[]> {
    return [...(this.running ? [hostConn] : []), ...this.joined];
  }
  async forget(id: string): Promise<void> {
    this.joined = this.joined.filter((c) => c.id !== id);
  }
  async op<T>(connection: string, op: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ connection, op, args });
    const answers: Record<string, unknown> = {
      workspaces: [{ id: "w_1", name: "Team" }],
      reports: [{ id: "sales", name: "Sales", version: 2, publisherKeyId: "k", uploadedBy: "x", updatedAt: "t", hasRoles: true }],
      members: [{ id: "m_1", name: "Ann", identity: "ann@x.com", role: "viewer", rlsRoles: ["Mine"], createdAt: "t", revoked: false }],
      audit: [{ time: "t", actor: "a", event: "join", detail: "" }],
      invite: { id: "i", token: "bfi_x", link: "biforge://open?src=server&url=u&invite=bfi_x", expiresAt: "t" },
      versions: [
        { version: 2, uploadedBy: "x", at: "2026-10-20T10:00:00Z", sizeBytes: 2048, current: true },
        { version: 1, uploadedBy: "x", at: "2026-10-19T10:00:00Z", sizeBytes: 1024, current: false },
      ],
      query: { results: [{ columns: ["[t]"], rows: [[{ t: "int", v: "40" }]], totalRows: 1, truncated: false }], elapsedMs: 1 },
    };
    return (answers[op] ?? {}) as T;
  }
  async openReport(connection: string, workspace: string | null, report: string): Promise<OpenedServerReport> {
    return { root: "C:/cache/s", pbipPath: "C:/cache/s/Sales.pbip", connectionId: connection, workspaceId: workspace ?? "w_1", reportId: report, reportName: "Sales", version: 2, role: "viewer", identity: "ann@x.com", serverLabel: "Team on host" };
  }
  // ---- direct sessions ----
  p2pHost: P2pHostView = { running: true, code: "BF1-abc-0123456789", ticket: "BF1T-xyz", expiresAt: 4102444800, version: 1, pending: [{ id: 1, name: "Zoe", endpointId: "e1", requestedAt: 1 }], peers: [], pushes: [] };
  p2pCalls: string[] = [];
  p2pGuest: P2pGuestView = { state: "waiting", reason: "", role: "readOnly", hostId: "h1", newPackage: null, message: null };
  async p2pHostState(): Promise<P2pHostView> {
    return structuredClone(this.p2pHost);
  }
  async p2pApprove(target: string, request: number, role: P2pRole): Promise<void> {
    this.p2pCalls.push(`approve:${target}:${request}:${role}`);
    this.p2pHost = { ...this.p2pHost, pending: this.p2pHost.pending.filter((p) => p.id !== request), peers: [{ endpointId: "e1", name: "Zoe", role, connected: true, revoked: false, approvedAt: 2 }] };
  }
  async p2pDeny(target: string, request: number): Promise<void> {
    this.p2pCalls.push(`deny:${target}:${request}`);
    this.p2pHost = { ...this.p2pHost, pending: [] };
  }
  async p2pRevoke(target: string, endpointId: string): Promise<void> {
    this.p2pCalls.push(`revoke:${target}:${endpointId}`);
    this.p2pHost = { ...this.p2pHost, peers: this.p2pHost.peers.map((p) => ({ ...p, revoked: true, connected: false })) };
  }
  async p2pTakePush(target: string, push: number): Promise<string> {
    this.p2pCalls.push(`take:${target}:${push}`);
    return "C:/incoming/zoe-1.biforge";
  }
  async p2pJoin(code: string, name: string): Promise<string> {
    this.p2pCalls.push(`join:${code}:${name}`);
    return "g_1";
  }
  async p2pGuestState(): Promise<P2pGuestView> {
    const v = structuredClone(this.p2pGuest);
    this.p2pGuest = { ...this.p2pGuest, newPackage: null, message: null };
    return v;
  }
  async p2pPush(id: string, path: string): Promise<void> {
    this.p2pCalls.push(`push:${id}:${path}`);
  }
  async p2pLeave(id: string): Promise<void> {
    this.p2pCalls.push(`leave:${id}`);
  }
}
