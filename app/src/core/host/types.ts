// Mirrors the serde JSON of biforge_publish::backend (camelCase) and app/src-tauri/src/host.rs.

export type WsRole = "viewer" | "editor" | "admin";

export interface Connection {
  id: string;
  label: string;
  url: string;
  /** Empty for the host's own connection (it reaches every workspace). */
  workspaceId: string;
  workspaceName: string;
  role: WsRole;
  identity: string;
  isHost: boolean;
  /** SHA-256 fingerprint of the server's self-signed certificate (https servers). */
  pin?: string | null;
}

export interface VersionInfo {
  version: number;
  uploadedBy: string;
  at: string;
  sizeBytes: number;
  /** The version the server answers with now. */
  current: boolean;
}

export interface HostStatus {
  running: boolean;
  url: string;
  /** The certificate fingerprint when the host speaks https. */
  fingerprint?: string | null;
  adminToken: string | null;
  lan: boolean;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface Member {
  id: string;
  name: string;
  identity: string;
  role: WsRole;
  rlsRoles: string[];
  createdAt: string;
  revoked: boolean;
}

export interface InviteRequest {
  role: WsRole;
  identity: string;
  rlsRoles: string[];
  expiresMinutes: number;
}

export interface InviteInfo {
  id: string;
  token: string;
  link: string;
  expiresAt: string;
}

export interface ServerReport {
  id: string;
  name: string;
  version: number;
  publisherKeyId: string;
  uploadedBy: string;
  updatedAt: string;
  hasRoles: boolean;
}

export interface AuditEntry {
  time: string;
  actor: string;
  event: string;
  detail: string;
}

export interface RlsRole {
  name: string;
  filters: { table: string; expression: string }[];
}

export interface OpenedServerReport {
  root: string;
  pbipPath: string;
  connectionId: string;
  workspaceId: string;
  reportId: string;
  reportName: string;
  version: number;
  role: WsRole;
  identity: string;
  serverLabel: string;
}

/** Where a report opened for viewing comes from (queries go to this server, not to a local store). */
export interface ServerRef {
  connectionId: string;
  workspaceId: string;
  reportId: string;
  role: WsRole;
  identity: string;
  serverLabel: string;
}

export type P2pRole = "readOnly" | "edit";

export interface P2pJoinRequest {
  id: number;
  name: string;
  endpointId: string;
  requestedAt: number;
}

export interface P2pPeer {
  endpointId: string;
  name: string;
  role: P2pRole;
  connected: boolean;
  revoked: boolean;
  approvedAt: number;
}

export interface P2pPush {
  id: number;
  from: string;
  name: string;
  bytes: number;
  receivedAt: number;
}

/** The host side of a direct session (one per publication target). */
export interface P2pHostView {
  running: boolean;
  code: string;
  ticket: string;
  expiresAt: number;
  version: number;
  pending: P2pJoinRequest[];
  peers: P2pPeer[];
  pushes: P2pPush[];
}

export interface P2pGuestView {
  state: "waiting" | "approved" | "denied" | "ended";
  reason: string;
  role: P2pRole;
  hostId: string;
  newPackage: { version: number; path: string } | null;
  message: string | null;
}

export interface HostApi {
  status(): Promise<HostStatus>;
  start(lan: boolean, port: number | null, publicUrl: string | null, tls?: boolean): Promise<HostStatus>;
  stop(): Promise<void>;
  join(linkOrUrl: string, invite: string | null, displayName: string, pin?: string | null): Promise<Connection>;
  /** Signs in to a standalone server as its administrator with the token it printed. */
  connectAdmin(url: string, adminToken: string, pin: string | null): Promise<Connection>;
  connections(): Promise<Connection[]>;
  forget(id: string): Promise<void>;
  /** One call to a server; `op` names it (workspaces, createWorkspace, invite, members, setMember, revoke, audit, reports, deleteReport, versions, restoreVersion, roles, setRoles, query). */
  op<T = unknown>(connection: string, op: string, args: Record<string, unknown>): Promise<T>;
  openReport(connection: string, workspace: string | null, report: string): Promise<OpenedServerReport>;
  p2pHostState(target: string): Promise<P2pHostView>;
  p2pApprove(target: string, request: number, role: P2pRole): Promise<void>;
  p2pDeny(target: string, request: number): Promise<void>;
  p2pRevoke(target: string, endpointId: string): Promise<void>;
  /** Saves a changed copy a guest sent as a .biforge file; returns its path. */
  p2pTakePush(target: string, push: number): Promise<string>;
  /** Connects with a pairing code; returns the guest session id (the host still has to approve). */
  p2pJoin(code: string, name: string): Promise<string>;
  p2pGuestState(id: string): Promise<P2pGuestView>;
  p2pPush(id: string, path: string): Promise<void>;
  p2pLeave(id: string): Promise<void>;
}
