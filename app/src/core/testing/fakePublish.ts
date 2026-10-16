// Test double for PublishApi: adapters are programmable, nothing touches a disk or the network.
import type { AdapterInfo, AuditEvent, Capabilities, DeepLink, Envelope, Issue, OpenedPackage, Outcome, PublishApi, RemoteState, RunArgs, Target } from "../publish/types";

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

export function planned(id: string, name: string, method: AdapterInfo["method"], phase: string, free: string[]): AdapterInfo {
  return { id, name, method, phase, capabilities: { ...NONE }, limitations: ["Planned."], freeTier: free };
}

export const defaultAdapters = (): AdapterInfo[] => [
  fakeFolderAdapter,
  planned("github-pages", "GitHub Pages", "staticHosting", "O2", ["Free GitHub account, no payment card"]),
  planned("google-drive", "Google Drive", "personalStorage", "O3", ["Free Google account, 15 GB shared with Gmail and Photos"]),
  planned("p2p", "Direct connection (peer to peer)", "peerToPeer", "O4", ["Free; may use free public relay servers"]),
  planned("host-from-pc", "Host from this PC", "backend", "O5", ["Free; uses your PC"]),
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
    if (link.includes("src=p2p")) return { src: "p2p", path: null, supported: false };
    return { src: "file", path: decodeURIComponent((link.split("path=")[1] ?? "").replace(/\+/g, " ")), supported: true };
  }
  async startupOpen() {
    return this.startup;
  }
}
