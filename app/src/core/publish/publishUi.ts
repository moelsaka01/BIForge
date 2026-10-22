// State and logic of the Publish & Share dialog. Components only render this and dispatch commands; the commands
// (core/commands/publishCommands.ts) call these methods.
import type { Session } from "../session/session";
import { toStored } from "../report/storage";
import { getTableSource } from "../model/tables";
import { pruneForPublishing, sameSelection } from "./prune";
import type { AccessLevel, AdapterInfo, AuditEvent, IncludedTable, Issue, LocalRefreshInfo, Outcome, Provider, PublishApi, RefreshPlan, RefreshSchedule, ServerRefreshInfo, StorageProvider, Target, VersionInfo } from "./types";

export const STORAGE_PROVIDERS: StorageProvider[] = ["google-drive", "onedrive", "dropbox"];
export const isStorageProvider = (id: string): id is StorageProvider => (STORAGE_PROVIDERS as string[]).includes(id);

/** Sign-in state of a personal storage account. */
export interface StorageAccountState {
  connected: boolean;
  account: string | null;
  /** The browser sign-in is open and BIForge waits for the answer. */
  pending: boolean;
  message: string | null;
  /** The client id of the registered app is known (otherwise the sign-in cannot start and the form asks for it). */
  clientId: boolean;
}

/** The account behind a destination, for destinations that need one. */
export const PROVIDER_OF: Record<string, Provider> = { "github-pages": "github", "cloudflare-pages": "cloudflare" };

export interface PublishState {
  loaded: boolean;
  adapters: AdapterInfo[];
  targets: Target[];
  selected: string | null;
  issues: Issue[];
  /** Tables and columns that have data and can be published (everything is chosen by default). */
  available: IncludedTable[];
  /** What the user ticked. */
  chosen: IncludedTable[];
  /** Problems the pruned model will have in the published copy. */
  warnings: string[];
  busy: boolean;
  error: string | null;
  /** Result of the last publish: version, and the access key when one was just made (shown once). */
  outcome: (Outcome & { targetId: string; rotated: boolean }) | null;
  link: string | null;
  audit: AuditEvent[];
  /** Providers with a stored token, with the account name the provider reported when it was connected. */
  connected: Partial<Record<Provider, string>>;
  /** Personal storage accounts by provider id. */
  storage: Record<string, StorageAccountState>;
  /** The provider's version history of the selected destination. */
  versions: VersionInfo[] | null;
  /** The last publish found that someone else changed the stored file; Overwrite is offered. */
  conflict: boolean;
  /** Scheduled refresh of the selected destination on this PC, and on the server when the destination is one. */
  localRefresh: LocalRefreshInfo | null;
  serverRefresh: ServerRefreshInfo | null;
}

const EMPTY: PublishState = { loaded: false, adapters: [], targets: [], selected: null, issues: [], available: [], chosen: [], warnings: [], busy: false, error: null, outcome: null, link: null, audit: [], connected: {}, storage: {}, versions: null, conflict: false, localRefresh: null, serverRefresh: null };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class PublishUi {
  private snap: PublishState = EMPTY;
  private listeners = new Set<() => void>();

  constructor(private readonly session: Session) {}

  getSnapshot = (): PublishState => this.snap;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<PublishState>): void {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }

  private get api(): PublishApi {
    if (!this.session.publish) throw new Error("Publishing is not available in this window.");
    return this.session.publish;
  }
  private get root(): string {
    const r = this.session.root;
    if (!r || !this.session.store.project) throw new Error("Open a project first.");
    return r;
  }

  // ---- personal storage accounts ----

  private storageTimer: ReturnType<typeof setInterval> | null = null;

  async storageRefresh(provider: StorageProvider): Promise<void> {
    const connected = await this.api.storageConnected(provider);
    const prev = this.snap.storage[provider];
    const clientId = await this.api.storageClientIdKnown(provider).catch(() => false);
    this.set({ storage: { ...this.snap.storage, [provider]: { connected, account: connected ? (prev?.account ?? null) : null, pending: prev?.pending ?? false, message: prev?.message ?? null, clientId } } });
  }

  private setStorage(provider: StorageProvider, patch: Partial<StorageAccountState>): void {
    const prev = this.snap.storage[provider] ?? { connected: false, account: null, pending: false, message: null, clientId: true };
    this.set({ storage: { ...this.snap.storage, [provider]: { ...prev, ...patch } } });
  }

  /** Opens the provider's sign-in page in the browser and waits for the answer on the loopback address. */
  async storageConnect(provider: StorageProvider): Promise<void> {
    if (this.storageTimer) clearInterval(this.storageTimer);
    this.storageTimer = null;
    try {
      const url = await this.api.storageConnectStart(provider);
      this.setStorage(provider, { pending: true, message: null });
      await this.session.io.openUrl?.(url);
    } catch (e) {
      this.setStorage(provider, { pending: false, message: errText(e) });
      throw e;
    }
    const poll = async () => {
      const st = await this.api.storageConnectStatus(provider).catch((e) => ({ state: "error" as const, account: null, message: errText(e) }));
      if (st.state === "pending" || st.state === "none") return;
      if (this.storageTimer) clearInterval(this.storageTimer);
      this.storageTimer = null;
      if (st.state === "done") {
        this.setStorage(provider, { connected: true, account: st.account, pending: false, message: null });
        this.session.setMessage(`Connected ${provider} as ${st.account ?? "your account"}.`);
        await this.checkSelected();
      } else {
        this.setStorage(provider, { connected: false, pending: false, message: st.message ?? "The sign-in did not finish." });
      }
    };
    this.storageTimer = setInterval(() => void poll(), 1500);
    await poll();
  }

  /** Keeps the public client id of the app registered with the provider (from the provider's console), then retries. */
  async storageSetClientId(provider: StorageProvider, id: string): Promise<void> {
    await this.api.storageSetClientId(provider, id);
    this.setStorage(provider, { clientId: true, message: null });
  }

  async storageDisconnect(provider: StorageProvider): Promise<void> {
    await this.api.storageDisconnect(provider);
    this.setStorage(provider, { connected: false, account: null, pending: false, message: null });
    await this.checkSelected();
  }

  async loadVersions(): Promise<void> {
    const id = this.snap.selected;
    if (!id) return;
    try {
      this.set({ versions: await this.api.versions(this.root, id), error: null });
    } catch (e) {
      this.set({ error: errText(e) });
    }
  }

  async shareWith(email: string, canEdit: boolean): Promise<void> {
    const id = this.snap.selected;
    if (!id) throw new Error("Choose a destination first.");
    if (!email.includes("@")) throw new Error("Enter the person's e-mail address.");
    await this.api.shareWith(this.root, id, email.trim(), canEdit);
    this.set({ audit: await this.api.audit(this.root) });
    this.session.setMessage(`Shared with ${email.trim()} (${canEdit ? "can edit" : "can view"}). They need an account with the provider.`);
  }

  /** Replaces a file someone else changed, once, then publishes. */
  async overwrite(publisherName: string): Promise<void> {
    const id = this.snap.selected;
    if (!id) throw new Error("Choose a destination first.");
    await this.api.allowOverwrite(this.root, id);
    this.set({ conflict: false });
    await this.publish(publisherName);
  }

  adapterOf(id: string): AdapterInfo | undefined {
    return this.snap.adapters.find((a) => a.id === id);
  }

  /** Loads adapters, targets and the tables that can be published. */
  async open(): Promise<void> {
    this.set({ busy: true, error: null, outcome: null, link: null });
    try {
      const root = this.root;
      const [adapters, targets, audit] = await Promise.all([this.api.adapters(), this.api.targets(root), this.api.audit(root)]);
      const connected = { ...this.snap.connected };
      for (const p of ['github', 'cloudflare'] as Provider[]) {
        if (await this.api.accountConnected(p)) connected[p] = connected[p] ?? '';
        else delete connected[p];
      }
      const available = await this.loadAvailable();
      const selected = this.snap.selected && targets.some((t) => t.id === this.snap.selected) ? this.snap.selected : (targets[0]?.id ?? null);
      this.set({ loaded: true, connected, adapters, targets, audit, available, chosen: available.map((t) => ({ ...t, columns: [...t.columns] })), selected, busy: false });
      await this.checkSelected();
      await this.loadRefresh();
      this.recomputeWarnings();
    } catch (e) {
      this.set({ busy: false, error: errText(e) });
    }
  }

  private async loadAvailable(): Promise<IncludedTable[]> {
    const eng = this.session.engine;
    if (!eng) return [];
    const out: IncludedTable[] = [];
    for (const t of this.session.getSnapshot().dataTables) {
      const info = await eng.tableInfo(t);
      if (info) out.push({ table: info.name, columns: info.columns.map((c) => c.name) });
    }
    return out.sort((a, b) => a.table.localeCompare(b.table));
  }

  private recomputeWarnings(): void {
    const p = this.session.store.project;
    this.set({ warnings: p ? pruneForPublishing(p, this.snap.chosen.filter((t) => t.columns.length > 0)).warnings : [] });
  }

  /** Ticks or unticks a column (`column` null: the whole table). */
  setChosen(table: string, column: string | null, on: boolean): void {
    const avail = this.snap.available.find((t) => t.table === table);
    if (!avail) return;
    const rest = this.snap.chosen.filter((t) => t.table !== table);
    let cols = this.snap.chosen.find((t) => t.table === table)?.columns ?? [];
    if (column === null) cols = on ? [...avail.columns] : [];
    else cols = on ? avail.columns.filter((c) => c === column || cols.includes(c)) : cols.filter((c) => c !== column);
    this.set({ chosen: [...rest, { table, columns: cols }].filter((t) => t.columns.length > 0 || t.table === table).sort((a, b) => a.table.localeCompare(b.table)), outcome: null });
    this.recomputeWarnings();
  }

  /** What would be published: only tables with at least one column. */
  selection(): IncludedTable[] {
    return this.snap.chosen.filter((t) => t.columns.length > 0);
  }

  async select(id: string | null): Promise<void> {
    this.set({ selected: id, outcome: null, link: null, error: null, localRefresh: null, serverRefresh: null });
    await this.checkSelected();
    await this.loadRefresh();
  }

  private async checkSelected(): Promise<void> {
    const id = this.snap.selected;
    if (!id) return this.set({ issues: [] });
    try {
      this.set({ issues: await this.api.validate(this.root, id) });
    } catch (e) {
      this.set({ issues: [{ severity: "error", message: errText(e) }] });
    }
  }

  /** Adds a destination to this report. The access level must be one the destination supports. */
  async addTarget(adapterId: string, label: string, access: AccessLevel, settings: Record<string, string>): Promise<string> {
    const info = this.adapterOf(adapterId);
    if (!info) throw new Error(`Unknown destination "${adapterId}".`);
    if (!info.capabilities.implemented) throw new Error(`${info.name} is not implemented yet (planned for phase ${info.phase}).`);
    if (access === "public" ? !info.capabilities.publicAccess : !info.capabilities.privateAccess) throw new Error(`${info.name} does not support ${access} reports.`);
    const name = label.trim();
    if (!name) throw new Error("Give the destination a name.");
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const target: Target = { id, adapterId, label: name, settings, access, account: null, packageId: null, lastVersion: null, lastSync: null, history: [], status: "neverPublished", lastError: null };
    await this.api.putTarget(this.root, target);
    const provider = PROVIDER_OF[adapterId];
    if (provider && this.snap.connected[provider] !== undefined) await this.api.authenticate(this.root, id).catch(() => undefined);
    this.set({ targets: await this.api.targets(this.root) });
    await this.select(id);
    return id;
  }

  /** Stores a token after the provider accepted it. Cloudflare also needs the account id. */
  async connect(provider: Provider, token: string, accountId?: string): Promise<string> {
    this.set({ busy: true, error: null });
    try {
      const name = await this.api.accountConnect(provider, token, accountId ?? null);
      this.set({ connected: { ...this.snap.connected, [provider]: name }, busy: false });
      await this.checkSelected();
      this.session.setMessage(`Connected ${provider === "github" ? "GitHub" : "Cloudflare"} as ${name}.`);
      return name;
    } catch (e) {
      this.set({ busy: false, error: errText(e) });
      throw e;
    }
  }

  async disconnect(provider: Provider): Promise<void> {
    await this.api.accountDisconnect(provider);
    const next = { ...this.snap.connected };
    delete next[provider];
    this.set({ connected: next });
    await this.checkSelected();
  }

  async removeTarget(id: string): Promise<void> {
    await this.api.deleteTarget(this.root, id);
    const targets = await this.api.targets(this.root);
    this.set({ targets });
    await this.select(targets[0]?.id ?? null);
  }

  async publish(publisherName: string, rotate = false): Promise<void> {
    const id = this.snap.selected;
    if (!id) throw new Error("Choose a destination first.");
    const target = this.snap.targets.find((t) => t.id === id)!;
    const info = this.adapterOf(target.adapterId);
    if (!info?.capabilities.implemented) throw new Error(`${info?.name ?? "This destination"} is not implemented yet.`);
    const project = this.session.store.project;
    if (!project) throw new Error("Open a project first.");
    const included = this.selection();
    if (included.length === 0) throw new Error("Choose at least one column to publish.");
    if (!publisherName.trim()) throw new Error("Enter the name viewers will see as the publisher.");
    if (this.snap.issues.some((i) => i.severity === "error")) throw new Error(this.snap.issues.find((i) => i.severity === "error")!.message);
    const confirmed = this.shownToUser;
    if (!sameSelection(included, confirmed)) throw new Error("The list of tables and columns changed; confirm it again.");
    this.set({ busy: true, error: null, outcome: null });
    try {
      const pruned = pruneForPublishing(project, included);
      const outcome = await this.api.run(this.root, toStored(pruned.project), { targetId: id, reportName: project.name, publisherName: publisherName.trim(), included, confirmed, rotate });
      const root = this.root;
      this.set({ outcome: { ...outcome, targetId: id, rotated: rotate }, targets: await this.api.targets(root), audit: await this.api.audit(root), busy: false });
      this.session.setMessage(`Published "${project.name}" to ${target.label} (version ${outcome.state.version}).`);
      await this.checkSelected();
    } catch (e) {
      this.set({ busy: false, error: errText(e), conflict: /Choose Overwrite/.test(errText(e)), targets: await this.api.targets(this.root).catch(() => this.snap.targets) });
      throw e;
    }
  }

  /** The list the user confirmed on screen: the dialog calls `confirmShown` when the confirm box is ticked. */
  private shownToUser: IncludedTable[] = [];
  confirmShown(on: boolean): void {
    this.shownToUser = on ? this.selection().map((t) => ({ ...t, columns: [...t.columns] })) : [];
    this.set({});
  }
  get confirmed(): boolean {
    return this.shownToUser.length > 0 && sameSelection(this.shownToUser, this.selection());
  }

  /** Published tables whose source is a file a GitHub runner could reload, and the ones it cannot reload (with the reason). */
  refreshCandidates(): { files: { table: string; path: string; kind: string }[]; blocked: { table: string; reason: string }[] } {
    const project = this.session.store.project;
    const files: { table: string; path: string; kind: string }[] = [];
    const blocked: { table: string; reason: string }[] = [];
    if (!project) return { files, blocked };
    for (const t of this.selection()) {
      const spec = getTableSource(project, t.table) as ({ kind: string; path?: string } & Record<string, unknown>) | null;
      if (!spec) blocked.push({ table: t.table, reason: "BIForge does not know where this table's data came from (it was typed in or made by a query)." });
      else if (spec.path && ["csv", "excel", "json", "parquet", "sqlite"].includes(spec.kind)) files.push({ table: t.table, path: spec.path, kind: spec.kind });
      else blocked.push({ table: t.table, reason: "The data comes from a database server, which a GitHub runner cannot reach with your credentials." });
    }
    return { files, blocked };
  }

  /** Turns on scheduled refresh for the selected destination. `confirmed` is the list of whole files the user agreed to put into the repository. */
  async enableRefresh(publisherName: string, schedule: RefreshSchedule, tables: string[], confirmed: string[], opts: { atMinute?: number; retries?: number } = {}): Promise<void> {
    const id = this.snap.selected;
    const project = this.session.store.project;
    if (!id || !project) throw new Error("Choose a destination first.");
    if (!publisherName.trim()) throw new Error("Enter the name viewers will see as the publisher.");
    const cands = this.refreshCandidates().files.filter((f) => tables.includes(f.table));
    if (cands.length === 0) throw new Error("Choose at least one table with a source file.");
    const sources = cands.map((c) => ({ table: c.table, spec: getTableSource(project, c.table) }));
    this.set({ busy: true, error: null });
    try {
      await this.api.enableRefresh(this.root, toStored(this.session.store.project), { targetId: id, reportName: project.name, publisherName: publisherName.trim(), included: this.selection(), schedule, ...opts, sources, confirmedSources: confirmed });
      this.set({ busy: false, targets: await this.api.targets(this.root), audit: await this.api.audit(this.root) });
      await this.loadRefresh();
      this.session.setMessage(`Scheduled refresh is on (${schedule}).`);
    } catch (e) {
      this.set({ busy: false, error: errText(e) });
      throw e;
    }
  }

  /** Reads the scheduled refresh state of the selected destination: on this PC and, for a server, on the server. */
  async loadRefresh(): Promise<void> {
    const id = this.snap.selected;
    if (!id) return this.set({ localRefresh: null, serverRefresh: null });
    const target = this.snap.targets.find((t) => t.id === id);
    let local: LocalRefreshInfo | null = null;
    let server: ServerRefreshInfo | null = null;
    try {
      local = await this.api.localRefreshInfo(this.root, id);
    } catch {
      /* the window has no backend */
    }
    if (target && (target.adapterId === "host-from-pc" || target.adapterId === "biforge-server") && this.session.host && target.settings.connection && target.settings.workspace && target.settings.report) {
      try {
        server = await this.session.host.op<ServerRefreshInfo>(target.settings.connection, "refreshInfo", { workspace: target.settings.workspace, report: target.settings.report });
      } catch {
        server = null; // not an editor of this workspace, or the server is not reachable
      }
    }
    this.set({ localRefresh: local, serverRefresh: server });
  }

  /** Turns on scheduled refresh on this PC (Windows Task Scheduler) for the selected destination. */
  async enableLocalRefresh(publisherName: string, plan: RefreshPlan): Promise<void> {
    const id = this.snap.selected;
    const project = this.session.store.project;
    if (!id || !project) throw new Error("Choose a destination first.");
    if (!publisherName.trim()) throw new Error("Enter the name viewers will see as the publisher.");
    const included = this.selection();
    if (included.length === 0) throw new Error("Choose at least one column to publish.");
    this.set({ busy: true, error: null });
    try {
      // the schedule publishes the report as it is now (pruned to what is published), like a click on Publish would
      const pruned = pruneForPublishing(project, included);
      const info = await this.api.localRefreshEnable(this.root, toStored(pruned.project), { targetId: id, reportName: project.name, publisherName: publisherName.trim(), included, plan });
      this.set({ busy: false, localRefresh: info, audit: await this.api.audit(this.root) });
      this.session.setMessage(`Scheduled refresh on this PC is on (${plan.frequency}).`);
    } catch (e) {
      this.set({ busy: false, error: errText(e) });
      throw e;
    }
  }

  async disableLocalRefresh(): Promise<void> {
    const id = this.snap.selected;
    if (!id) return;
    this.set({ localRefresh: await this.api.localRefreshDisable(this.root, id) });
    this.session.setMessage("Scheduled refresh on this PC is off.");
  }

  /** Runs the refresh on this PC now (it waits for the result and shows it in the history). */
  async runLocalRefresh(): Promise<void> {
    const id = this.snap.selected;
    if (!id) return;
    this.set({ busy: true, error: null });
    try {
      const rec = await this.api.localRefreshRun(this.root, id);
      this.set({ busy: false, localRefresh: await this.api.localRefreshInfo(this.root, id), targets: await this.api.targets(this.root) });
      this.session.setMessage(`Refresh on this PC: ${rec.status}. ${rec.message}`);
    } catch (e) {
      this.set({ busy: false, error: errText(e) });
      throw e;
    }
  }

  private serverTarget(): { connection: string; workspace: string; report: string } {
    const t = this.snap.targets.find((x) => x.id === this.snap.selected);
    const s = t?.settings ?? {};
    if (!t || !s.connection || !s.workspace || !s.report) throw new Error("Choose a destination on a BIForge server first.");
    return { connection: s.connection, workspace: s.workspace, report: s.report };
  }

  /** Runs the refresh on the server now. */
  async runServerRefresh(): Promise<void> {
    const t = this.serverTarget();
    if (!this.session.host) throw new Error("Hosting is not available in this window.");
    this.set({ busy: true, error: null });
    try {
      const rec = await this.session.host.op<{ status: string; message: string }>(t.connection, "refreshRun", { workspace: t.workspace, report: t.report });
      await this.loadRefresh();
      this.set({ busy: false });
      this.session.setMessage(`Refresh on the server: ${rec.status}. ${rec.message}`);
    } catch (e) {
      this.set({ busy: false, error: errText(e) });
      throw e;
    }
  }

  /** Puts a file from this PC into the report's source folder on the server (it replaces the copy of the same name). */
  async uploadServerSource(path: string): Promise<void> {
    const t = this.serverTarget();
    if (!this.session.host) throw new Error("Hosting is not available in this window.");
    await this.session.host.op(t.connection, "refreshSource", { workspace: t.workspace, report: t.report, path });
    await this.loadRefresh();
    this.session.setMessage("The file is in the server's source folder; the next refresh reads it.");
  }

  async disableRefresh(): Promise<void> {
    const id = this.snap.selected;
    if (!id) return;
    await this.api.disableRefresh(this.root, id);
    this.set({ targets: await this.api.targets(this.root), audit: await this.api.audit(this.root) });
    await this.loadRefresh();
    this.session.setMessage("Scheduled refresh is off.");
  }

  async refreshNow(): Promise<void> {
    const id = this.snap.selected;
    if (!id) return;
    const url = await this.api.refreshNow(this.root, id);
    this.set({ audit: await this.api.audit(this.root) });
    this.session.setMessage(`Refresh started. Watch it at ${url}`);
  }

  async unpublish(): Promise<void> {
    const id = this.snap.selected;
    if (!id) return;
    await this.api.unpublish(this.root, id);
    this.set({ targets: await this.api.targets(this.root), audit: await this.api.audit(this.root), outcome: null, link: null });
  }

  async makeLink(): Promise<void> {
    const id = this.snap.selected;
    if (!id) return;
    const link = await this.api.shareLink(this.root, id);
    this.set({ link, audit: await this.api.audit(this.root) });
  }

  async showAccessKey(): Promise<string | null> {
    const id = this.snap.selected;
    return id ? this.api.accessKey(this.root, id) : null;
  }
}
