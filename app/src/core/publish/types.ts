// Mirrors the serde JSON of biforge_publish (camelCase) and app/src-tauri/src/publish.rs.

export type AccessLevel = "public" | "private";
export type Role = "viewer" | "editor";
export type Method = "staticHosting" | "personalStorage" | "peerToPeer" | "backend" | "localFolder";

export interface Capabilities {
  implemented: boolean;
  publicAccess: boolean;
  privateAccess: boolean;
  update: boolean;
  sync: boolean;
  shareLink: boolean;
  unpublish: boolean;
  keyRotation: boolean;
  versionHistory: boolean;
  scheduledRefresh: boolean;
  rowLevelSecurity: boolean;
  liveSession: boolean;
  comments: boolean;
  coEdit: boolean;
  needsAccount: boolean;
}

export interface AdapterInfo {
  id: string;
  name: string;
  method: Method;
  /** Phase of docs/ONLINE_PLAN.md that builds it. */
  phase: string;
  capabilities: Capabilities;
  limitations: string[];
  freeTier: string[];
}

export interface IncludedTable {
  table: string;
  columns: string[];
  dataFile?: string;
}

export type TargetStatus = "neverPublished" | "published" | "unpublished" | "error";

export interface Target {
  id: string;
  adapterId: string;
  label: string;
  settings: Record<string, string>;
  access: AccessLevel;
  account: string | null;
  packageId: string | null;
  lastVersion: number | null;
  lastSync: string | null;
  history: [number, string][];
  status: TargetStatus;
  lastError: string | null;
}

export interface Issue {
  severity: "error" | "warning";
  message: string;
}

export interface RemoteState {
  packageId: string;
  version: number;
  sha256: string;
  location: string;
  updatedAt: string;
}

export interface RunArgs {
  targetId: string;
  reportName: string;
  publisherName: string;
  included: IncludedTable[];
  confirmed: IncludedTable[];
  rotate?: boolean;
}

export interface Outcome {
  state: RemoteState;
  newAccessKey: string | null;
}

export interface AuditEvent {
  time: string;
  event: string;
  targetId: string;
  adapterId: string;
  detail: string;
}

export interface Envelope {
  format: number;
  packageId: string;
  version: number;
  access: AccessLevel;
  encrypted: boolean;
  publisherPublicKey: string;
  payloadSha256: string;
  payloadLen: number;
}

export interface Manifest {
  formatVersion: number;
  packageId: string;
  version: number;
  reportName: string;
  publisher: { name: string; keyId: string; publicKey: string };
  access: AccessLevel;
  included: IncludedTable[];
  createdAt: string;
  rlsEnforced: boolean;
}

export interface OpenedPackage {
  root: string;
  pbipPath: string;
  manifest: Manifest;
  dataFiles: [string, string][];
}

export interface DeepLink {
  src: string;
  path: string | null;
  supported: boolean;
}

/** Everything the app asks of the publishing engine. The Tauri implementation is in tauriPublish.ts; tests use fakes. */
export interface PublishApi {
  adapters(): Promise<AdapterInfo[]>;
  targets(root: string): Promise<Target[]>;
  putTarget(root: string, target: Target): Promise<void>;
  deleteTarget(root: string, targetId: string): Promise<void>;
  validate(root: string, targetId: string): Promise<Issue[]>;
  run(root: string, project: unknown, args: RunArgs): Promise<Outcome>;
  unpublish(root: string, targetId: string): Promise<void>;
  shareLink(root: string, targetId: string): Promise<string>;
  accessKey(root: string, targetId: string): Promise<string | null>;
  status(root: string, targetId: string): Promise<RemoteState | null>;
  audit(root: string): Promise<AuditEvent[]>;
  peek(path: string): Promise<Envelope>;
  openPackage(path: string, accessKey?: string | null, expectedPublisher?: string | null): Promise<OpenedPackage>;
  parseLink(link: string): Promise<DeepLink>;
  startupOpen(): Promise<string | null>;
}
