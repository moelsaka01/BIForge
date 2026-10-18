// Test double for PublishApi: adapters are programmable, nothing touches a disk or the network.
import type { ConnectStatus, StorageProvider, VersionInfo, AdapterInfo, AuditEvent, Capabilities, DeepLink, Envelope, Issue, Linked, OpenedPackage, Outcome, Provider, PublishApi, RefreshArgs, RemoteState, RunArgs, Subscription, Target } from "../publish/types";

const NONE: Capabilities = {
  implemented: false, publicAccess: false, privateAccess: false, update: false, sync: false, shareLink: false, unpublish: false, keyRotation: false,
  versionHistory: false, scheduledRefresh: false, rowLevelSecurity: false, liveSession: false, comments: false, coEdit: false, needsAccount: false,
};

export const fakeFolderAdapter: AdapterInfo = {
  id: "local-folder",
  name: "Folder on this PC or network",
  method: "localFolder",
  phase: "O1",
  capabilities: { ...NONE, implemented: true, publicAccess: true, privateAccess: true, update: true, sync: true, shareLink: true, unpublish: true, keyRotation: true },
  limitations: ["There is no access control: whoever can open the folder can copy the package."],
  freeTier: ["No account and no limits except the space on your disk."],
};

export const fakeGithubAdapter: AdapterInfo = {
  id: "github-pages",
  name: "GitHub Pages",
  method: "staticHosting",
  phase: "O2",
  capabilities: { ...NONE, implemented: true, publicAccess: true, privateAccess: true, update: true, sync: true, shareLink: true, unpublish: true, keyRotation: true, versionHistory: true, scheduledRefresh: true, needsAccount: true },
  limitations: ["The site is public: anyone with the address can download the package."],
  freeTier: ["Free GitHub account, no payment card"],
};

export const fakeCloudflareAdapter: AdapterInfo = {
  ...fakeGithubAdapter,
  id: "cloudflare-pages",
  name: "Cloudflare (workers.dev)",
  capabilities: { ...fakeGithubAdapter.capabilities, scheduledRefresh: false },
  freeTier: ["Free Cloudflare account, no payment card"],
};

export function planned(id: string, name: string, method: AdapterInfo["method"], phase: string, free: string[]): AdapterInfo {
  return { id, name, method, phase, capabilities: { ...NONE }, limitations: ["Planned."], freeTier: free };
}

export const defaultAdapters = (): AdapterInfo[] => [
  fakeFolderAdapter,
  fakeGithubAdapter,
  fakeCloudflareAdapter,
  planned("google-drive", "Google Drive", "personalStorage", "O3", ["Free Google account, 15 GB shared with Gmail and Photos"]),
  planned("p2p", "Direct connection (peer to peer)", "peerToPeer", "O4", ["Free; may use free public relay servers"]),
  { ...fakeGithubAdapter, id: "host-from-pc", name: "Host from this PC", method: "backend", phase: "O5", capabilities: { ...fakeFolderAdapter.capabilities, privateAccess: false, keyRotation: false, rowLevelSecurity: true }, limitations: ["Plain HTTP"], freeTier: ["Free; uses your PC"] },
];

export class FakePublish implements PublishApi {
  adapterList: AdapterInfo[] = defaultAdapters();
  targetsByRoot = new Map<string, Target[]>();
  calls: string[] = [];
  runs: { root: string; args: RunArgs; project: unknown }[] = [];
  audit_: AuditEvent[] = [];
  validateIssues: Issue[] = [];
  fail: string | null = null;
  nextKey: string | null = "AGE-SECRET-KEY-1FAKE";
  startup: string | null = null;
  envelope: Envelope = { format: 1, packageId: "pkg1", version: 4, access: "public", encrypted: false, publisherPublicKey: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdE=", payloadSha256: "x", payloadLen: 1 };
  opened: OpenedPackage | null = null;
  openedWith: { path: string; key: string | null }[] = [];

  async adapters() {
    return this.adapterList;
  }
  async targets(root: string) {
    return structuredClone(this.targetsByRoot.get(root) ?? []);
  }
  async putTarget(root: string, t: Target) {
    this.calls.push(`put:${t.id}`);
    const l = (this.targetsByRoot.get(root) ?? []).filter((x) => x.id !== t.id);
    this.targetsByRoot.set(root, [...l, structuredClone(t)]);
  }
  async deleteTarget(root: string, id: string) {
    this.calls.push(`delete:${id}`);
    this.targetsByRoot.set(root, (this.targetsByRoot.get(root) ?? []).filter((x) => x.id !== id));
  }
  async validate() {
    return this.validateIssues;
  }
  async run(root: string, project: unknown, args: RunArgs): Promise<Outcome> {
    this.calls.push(args.rotate ? `rotate:${args.targetId}` : `run:${args.targetId}`);
    this.runs.push({ root, args, project });
    if (this.fail) throw new Error(this.fail);
    if (this.conflict) throw new Error('The file "Sales.biforge" in Google Drive was changed by someone else since your last upload. Nothing was overwritten. Choose Overwrite to replace it with this version, or download theirs first.');
    const list = this.targetsByRoot.get(root) ?? [];
    const t = list.find((x) => x.id === args.targetId)!;
    t.lastVersion = (t.lastVersion ?? 0) + 1;
    t.status = "published";
    t.lastSync = "2026-10-17T10:00:00Z";
    const state: RemoteState = { packageId: "pkg1", version: t.lastVersion, sha256: "h", location: `${t.settings.folder ?? "dest"}/pkg1.biforge`, updatedAt: t.lastSync };
    const first = t.lastVersion === 1 && t.access === "private";
    return { state, newAccessKey: first || args.rotate ? this.nextKey : null };
  }
  async unpublish(root: string, id: string) {
    this.calls.push(`unpublish:${id}`);
    const t = (this.targetsByRoot.get(root) ?? []).find((x) => x.id === id);
    if (t) t.status = "unpublished";
  }
  refreshArgs: RefreshArgs[] = [];
  async enableRefresh(root: string, _project: unknown, args: RefreshArgs) {
    this.calls.push(`refresh-on:${args.targetId}:${args.schedule}`);
    this.refreshArgs.push(args);
    if (this.fail) throw new Error(this.fail);
    const t = (this.targetsByRoot.get(root) ?? []).find((x) => x.id === args.targetId)!;
    t.settings.refresh = args.schedule;
  }
  async disableRefresh(root: string, id: string) {
    this.calls.push(`refresh-off:${id}`);
    const t = (this.targetsByRoot.get(root) ?? []).find((x) => x.id === id)!;
    delete t.settings.refresh;
  }
  async refreshNow(_root: string, id: string) {
    this.calls.push(`refresh-now:${id}`);
    return "https://github.com/ann/site/actions";
  }
  async shareLink(_root: string, id: string) {
    this.calls.push(`link:${id}`);
    return "biforge://open?src=file&path=C%3A%5Cshare%5Cpkg1.biforge";
  }
  async accessKey() {
    return this.nextKey;
  }
  async status() {
    return null;
  }
  async audit() {
    return this.audit_;
  }
  async peek(path: string) {
    this.calls.push(`peek:${path}`);
    if (path.includes("bad")) throw new Error("the package signature is not valid: the package was changed or was not signed by the publisher it names");
    return this.envelope;
  }
  async openPackage(path: string, key?: string | null) {
    this.openedWith.push({ path, key: key ?? null });
    if (this.envelope.encrypted && !key) throw new Error("this package is encrypted: an access key is needed");
    if (!this.opened) throw new Error("no package prepared");
    return this.opened;
  }
  async parseLink(link: string): Promise<DeepLink> {
    if (!link.startsWith("biforge://")) throw new Error("this is not a biforge:// link");
    if (link.includes("src=p2p")) return { src: "p2p", path: null, url: null, supported: false };
    if (link.includes("src=url")) return { src: "url", path: null, url: decodeURIComponent(link.split("url=")[1] ?? ""), supported: true };
    return { src: "file", url: null, path: decodeURIComponent((link.split("path=")[1] ?? "").replace(/\+/g, " ")), supported: true };
  }
  async startupOpen() {
    return this.startup;
  }

  connected = new Set<Provider>();
  tokenError: string | null = null;
  subs: Subscription[] = [];
  /** What the next subscriptionCheck finds (null = up to date). */
  newer: Linked | null = null;
  linked: Linked = { path: "C:\\Downloads\\pkg1.biforge", envelope: this.envelope, existingPin: null };
  storage: Record<string, { connected: boolean; account: string | null }> = {};
  storageStatus: ConnectStatus = { state: "none", account: null, message: null };
  versionList: VersionInfo[] = [{ id: "r2", modified: "2026-10-18T10:00:02Z", size: 2048 }, { id: "r1", modified: "2026-10-18T10:00:01Z", size: 1024 }];
  conflict = false;
  async storageConnected(p: StorageProvider) {
    return this.storage[p]?.connected === true;
  }
  async storageConnectStart(p: StorageProvider) {
    this.calls.push(`storage-start:${p}`);
    this.storageStatus = { state: "pending", account: null, message: null };
    return `https://accounts.example/${p}/authorize?state=abc`;
  }
  async storageConnectStatus(_p: StorageProvider) {
    return this.storageStatus;
  }
  async storageDisconnect(p: StorageProvider) {
    this.calls.push(`storage-disconnect:${p}`);
    this.storage[p] = { connected: false, account: null };
  }
  async versions(_root: string, targetId: string) {
    this.calls.push(`versions:${targetId}`);
    return this.versionList;
  }
  async shareWith(_root: string, targetId: string, email: string, canEdit: boolean) {
    this.calls.push(`share-with:${targetId}:${email}:${canEdit ? "edit" : "view"}`);
  }
  async allowOverwrite(_root: string, targetId: string) {
    this.calls.push(`overwrite:${targetId}`);
    this.conflict = false;
  }
  async accountConnected(p: Provider) {
    return this.connected.has(p);
  }
  async accountConnect(p: Provider, token: string, accountId?: string | null) {
    this.calls.push(`connect:${p}:${accountId ?? ""}`);
    if (this.tokenError || token === "bad") throw new Error(this.tokenError ?? "GitHub did not accept the token");
    this.connected.add(p);
    return p === "github" ? "ann" : "ann-subdomain";
  }
  async accountDisconnect(p: Provider) {
    this.calls.push(`disconnect:${p}`);
    this.connected.delete(p);
  }
  async authenticate(root: string, id: string) {
    const t = (this.targetsByRoot.get(root) ?? []).find((x) => x.id === id)!;
    t.account = "ann";
    return structuredClone(t);
  }
  async linkedFetch(url: string) {
    this.calls.push(`fetch:${url}`);
    return this.linked;
  }
  async subscriptionAccept(feedUrl: string, path: string, reportName: string, key?: string | null) {
    this.calls.push(`subscribe:${feedUrl}:${key ?? ""}`);
    const s: Subscription = { packageId: this.envelope.packageId, feedUrl, reportName, pinnedPublisher: this.envelope.publisherPublicKey, haveVersion: this.envelope.version, lastCheck: null, lastError: null, packagePath: path };
    this.subs = [...this.subs.filter((x) => x.packageId !== s.packageId), s];
    return s;
  }
  async subscriptions() {
    return this.subs;
  }
  async subscriptionRemove(id: string) {
    this.subs = this.subs.filter((s) => s.packageId !== id);
  }
  async subscriptionCheck(id: string) {
    this.calls.push(`check:${id}`);
    return this.newer;
  }
  async subscriptionOpened(id: string, version: number) {
    this.calls.push(`opened:${id}:${version}`);
  }
  async viewerKey() {
    return "AGE-SECRET-KEY-1STORED";
  }
}
