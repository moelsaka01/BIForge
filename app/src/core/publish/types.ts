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
  /** The destination's own revision marker of the stored file, where it keeps one. */
  rev?: string | null;
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

export type RefreshSchedule = "hourly" | "daily" | "weekly" | "manual";

/** When and how a scheduled refresh runs. The time of day is UTC on a server and local time on this PC. */
export interface RefreshPlan {
  frequency: RefreshSchedule;
  /** Minute of the day, 0 to 1439. */
  atMinute: number;
  /** Extra attempts after a failure. */
  retries: number;
  retryDelaySecs: number;
}

export type RunsOn = "githubActions" | "thisPc" | "server";

/** One attempt of a scheduled refresh, with where it ran. */
export interface RunRecord {
  runsOn: RunsOn;
  trigger: "scheduled" | "manual";
  attempt: number;
  startedAt: number;
  finishedAt: number;
  status: "refreshed" | "unchanged" | "failed" | "skipped";
  message: string;
  version: number | null;
}

/** Scheduled refresh on this PC (Windows Task Scheduler). */
export interface LocalRefreshInfo {
  enabled: boolean;
  plan: RefreshPlan | null;
  runsOn: string;
  needs: string;
  running: boolean;
  history: RunRecord[];
  task: { name: string; exists: boolean; status: string; nextRun: string } | null;
}

/** Scheduled refresh of a report on a BIForge server. */
export interface ServerRefreshInfo {
  enabled: boolean;
  plan: RefreshPlan;
  runsOn: string;
  needs: string;
  hasBundle: boolean;
  running: boolean;
  sourceFolder: string;
  sources: string[];
  history: RunRecord[];
  refreshedAt: string | null;
}

export interface LocalRefreshArgs {
  targetId: string;
  reportName: string;
  publisherName: string;
  included: IncludedTable[];
  plan: RefreshPlan;
}

export interface RefreshArgs {
  targetId: string;
  reportName: string;
  publisherName: string;
  included: IncludedTable[];
  schedule: RefreshSchedule;
  /** Retries and time of day (UTC minutes) for a runner that honors them (a server). */
  retries?: number;
  atMinute?: number;
  /** The tables whose source file the runner reloads, with the engine's description of the source (paths on this PC). */
  sources: { table: string; spec: unknown }[];
  /** The file names the user confirmed on screen; must equal the names of the sources. */
  confirmedSources: string[];
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

export type StorageProvider = "google-drive" | "onedrive" | "dropbox";

export interface ConnectStatus {
  state: "none" | "pending" | "done" | "error";
  account: string | null;
  message: string | null;
}

export interface VersionInfo {
  id: string;
  modified: string;
  size: number;
}

export interface DeepLink {
  src: string;
  path: string | null;
  /** The feed address of a link that points at a static host. */
  url: string | null;
  supported: boolean;
  /** Invitation code of a server link. */
  invite?: string | null;
}

/** A package downloaded from a feed address, with its signed envelope; `existingPin` is the publisher key pinned earlier. */
export interface Linked {
  path: string;
  envelope: Envelope;
  existingPin: string | null;
}

export interface Subscription {
  packageId: string;
  feedUrl: string;
  reportName: string;
  pinnedPublisher: string;
  haveVersion: number;
  lastCheck: string | null;
  lastError: string | null;
  packagePath: string;
}

export type Provider = "github" | "cloudflare";

/** Everything the app asks of the publishing engine. The Tauri implementation is in tauriPublish.ts; tests use fakes. */
export interface PublishApi {
  adapters(): Promise<AdapterInfo[]>;
  targets(root: string): Promise<Target[]>;
  putTarget(root: string, target: Target): Promise<void>;
  deleteTarget(root: string, targetId: string): Promise<void>;
  validate(root: string, targetId: string): Promise<Issue[]>;
  run(root: string, project: unknown, args: RunArgs): Promise<Outcome>;
  unpublish(root: string, targetId: string): Promise<void>;
  enableRefresh(root: string, project: unknown, args: RefreshArgs): Promise<void>;
  disableRefresh(root: string, targetId: string): Promise<void>;
  /** Scheduled refresh on this PC through Windows Task Scheduler. */
  localRefreshInfo(root: string, targetId: string): Promise<LocalRefreshInfo>;
  localRefreshEnable(root: string, project: unknown, args: LocalRefreshArgs): Promise<LocalRefreshInfo>;
  localRefreshDisable(root: string, targetId: string): Promise<LocalRefreshInfo>;
  /** Runs one refresh now and waits for it. */
  localRefreshRun(root: string, targetId: string): Promise<RunRecord>;
  /** Starts one refresh on the runner; returns the address where it can be watched. */
  refreshNow(root: string, targetId: string): Promise<string>;
  shareLink(root: string, targetId: string): Promise<string>;
  accessKey(root: string, targetId: string): Promise<string | null>;
  status(root: string, targetId: string): Promise<RemoteState | null>;
  audit(root: string): Promise<AuditEvent[]>;
  peek(path: string): Promise<Envelope>;
  openPackage(path: string, accessKey?: string | null, expectedPublisher?: string | null): Promise<OpenedPackage>;
  parseLink(link: string): Promise<DeepLink>;
  startupOpen(): Promise<string | null>;
  /** Whether a token is stored for the provider (the token itself never reaches the window again). */
  accountConnected(provider: Provider): Promise<boolean>;
  /** Stores the token in the Credential Manager after the provider accepted it; returns the account name. */
  accountConnect(provider: Provider, token: string, accountId?: string | null): Promise<string>;
  accountDisconnect(provider: Provider): Promise<void>;
  /** Personal storage (Google Drive, OneDrive, Dropbox): the sign-in happens in the browser with PKCE on a loopback address. */
  storageConnected(provider: StorageProvider): Promise<boolean>;
  /** Starts the sign-in; returns the address to open in the browser. */
  storageConnectStart(provider: StorageProvider): Promise<string>;
  storageConnectStatus(provider: StorageProvider): Promise<ConnectStatus>;
  /** Whether the client id of the app registered with the provider is known (the id is a public value). */
  storageClientIdKnown(provider: StorageProvider): Promise<boolean>;
  storageSetClientId(provider: StorageProvider, id: string): Promise<void>;
  storageDisconnect(provider: StorageProvider): Promise<void>;
  /** The provider's own version history of the stored file, newest first. */
  versions(root: string, targetId: string): Promise<VersionInfo[]>;
  /** Gives one person access through the provider. */
  shareWith(root: string, targetId: string, email: string, canEdit: boolean): Promise<void>;
  /** Lets the next publish replace a file someone else changed. */
  allowOverwrite(root: string, targetId: string): Promise<void>;
  /** Checks the destination's account and records its name on the target. */
  authenticate(root: string, targetId: string): Promise<Target>;
  linkedFetch(feedUrl: string): Promise<Linked>;
  subscriptionAccept(feedUrl: string, path: string, reportName: string, accessKey?: string | null): Promise<Subscription>;
  subscriptions(): Promise<Subscription[]>;
  subscriptionRemove(packageId: string): Promise<void>;
  /** A newer version of a subscribed report, downloaded and checked against the pinned publisher; null when up to date. */
  subscriptionCheck(packageId: string): Promise<Linked | null>;
  subscriptionOpened(packageId: string, version: number, path: string): Promise<void>;
  viewerKey(packageId: string): Promise<string | null>;
}
