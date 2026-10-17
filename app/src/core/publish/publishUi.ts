// State and logic of the Publish & Share dialog. Components only render this and dispatch commands; the commands
// (core/commands/publishCommands.ts) call these methods.
import type { Session } from "../session/session";
import { pruneForPublishing, sameSelection } from "./prune";
import type { AccessLevel, AdapterInfo, AuditEvent, IncludedTable, Issue, Outcome, Provider, PublishApi, Target } from "./types";

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
}

const EMPTY: PublishState = { loaded: false, adapters: [], targets: [], selected: null, issues: [], available: [], chosen: [], warnings: [], busy: false, error: null, outcome: null, link: null, audit: [], connected: {} };

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
    this.set({ selected: id, outcome: null, link: null, error: null });
    await this.checkSelected();
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
      const outcome = await this.api.run(this.root, pruned.project, { targetId: id, reportName: project.name, publisherName: publisherName.trim(), included, confirmed, rotate });
      const root = this.root;
      this.set({ outcome: { ...outcome, targetId: id, rotated: rotate }, targets: await this.api.targets(root), audit: await this.api.audit(root), busy: false });
      this.session.setMessage(`Published "${project.name}" to ${target.label} (version ${outcome.state.version}).`);
      await this.checkSelected();
    } catch (e) {
      this.set({ busy: false, error: errText(e), targets: await this.api.targets(this.root).catch(() => this.snap.targets) });
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
