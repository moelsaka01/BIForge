// Publish & Share and viewing mode. The dialog only dispatches these ids.
import type { CommandRegistry } from "./registry";
import type { Session } from "../session/session";
import type { AccessLevel, Provider } from "../publish/types";

const hasProject = (s: Session) => s.store.project !== null && s.getSnapshot().viewing === null;
const hasApi = (s: Session) => s.publish !== null;

export const VIEWING_MESSAGE = "This report is open for viewing only. Close it, and open the project itself to change it.";

/** Commands that stay available while a shared report is open: windows, panes, page changes, drilling, leaving. */
const VIEWING_ALLOWED: RegExp[] = [
  /^app\./,
  /^view\.(report|zoom)$/,
  /^pane\.toggle$/,
  /^report\.page\.go$/,
  /^report\.button\.run$/,
  /^report\.visuals\.(pause|refresh)$/,
  /^report\.view\./,
  // what a reader sees may change (view changes, not edits): slicer selections, filters, bookmarks
  /^report\.(slicer\.select|filter\.(upsert|remove)|bookmark\.apply)$/,
  // personalizing a visual (the command itself checks that the page allows it)
  /^report\.(visual\.setType|field\.(add|remove|setAggregation))$/,
  /^file\.(close|open|new|newBlank|newSample|newSample\.run)$/,
  /^package\./,
  /^subscription\./,
  /^link\./,
];

export function viewingGuard(s: Session, id: string): string | null {
  if (!s.getSnapshot().viewing) return null;
  return VIEWING_ALLOWED.some((r) => r.test(id)) ? null : VIEWING_MESSAGE;
}

async function openLink(s: Session, link: string): Promise<void> {
  const parsed = await s.publish!.parseLink(link);
  if (parsed.supported && parsed.url) {
    s.shell.openDialog({ kind: "openPackage", feedUrl: parsed.url, fromLink: true });
    return;
  }
  if (!parsed.supported || !parsed.path) throw new Error(`This link uses a way of sharing ("${parsed.src}") that this version of BIForge cannot open yet.`);
  // a link never opens anything by itself: the confirmation dialog shows what it points to first
  s.shell.openDialog({ kind: "openPackage", path: parsed.path, fromLink: true });
}

export function registerPublishCommands(r: CommandRegistry<Session>): void {
  r.setGuard(viewingGuard);

  r.register({
    id: "publish.open",
    label: "Publish & Share",
    category: "Share",
    isEnabled: (s) => hasProject(s) && hasApi(s),
    async run(s) {
      s.shell.openDialog({ kind: "publish" });
      await s.publishUi.open();
    },
  });
  r.register({
    id: "publish.addTarget",
    label: "Add a destination",
    category: "Share",
    isEnabled: (s) => hasProject(s) && hasApi(s),
    async run(s, args) {
      const a = (args ?? {}) as { adapterId?: string; label?: string; access?: AccessLevel; settings?: Record<string, string> };
      if (!a.adapterId || !a.label || !a.access) throw new Error("Missing destination, name or access level.");
      await s.publishUi.addTarget(a.adapterId, a.label, a.access, a.settings ?? {});
    },
  });
  r.register({
    id: "account.connect",
    label: "Connect an account for publishing",
    category: "Share",
    isEnabled: hasApi,
    async run(s, args) {
      const a = (args ?? {}) as { provider?: Provider; token?: string; accountId?: string };
      if (a.provider !== "github" && a.provider !== "cloudflare") throw new Error("Choose GitHub or Cloudflare.");
      await s.publishUi.connect(a.provider, a.token ?? "", a.accountId);
    },
  });
  r.register({
    id: "account.disconnect",
    label: "Disconnect an account (removes the stored token)",
    category: "Share",
    isEnabled: hasApi,
    async run(s, args) {
      const p = (args as { provider?: Provider } | undefined)?.provider;
      if (p !== "github" && p !== "cloudflare") throw new Error("Choose GitHub or Cloudflare.");
      await s.publishUi.disconnect(p);
    },
  });
  r.register({
    id: "publish.removeTarget",
    label: "Remove a destination",
    category: "Share",
    isEnabled: (s) => hasProject(s) && hasApi(s),
    async run(s, args) {
      const id = (args as { id?: string } | undefined)?.id;
      if (!id) throw new Error("Missing destination.");
      await s.publishUi.removeTarget(id);
    },
  });
  r.register({
    id: "publish.run",
    label: "Publish",
    category: "Share",
    isEnabled: (s) => hasProject(s) && hasApi(s),
    async run(s, args) {
      const a = (args ?? {}) as { publisherName?: string; rotate?: boolean };
      await s.publishUi.publish(a.publisherName ?? "", a.rotate === true);
    },
  });
  r.register({
    id: "publish.unpublish",
    label: "Stop sharing (remove from the destination)",
    category: "Share",
    isEnabled: (s) => hasProject(s) && hasApi(s),
    run: (s) => s.publishUi.unpublish(),
  });
  r.register({
    id: "publish.link",
    label: "Create share link",
    category: "Share",
    isEnabled: (s) => hasProject(s) && hasApi(s),
    run: (s) => s.publishUi.makeLink(),
  });

  // ---- viewing mode ----
  r.register({
    id: "package.open",
    label: "Open a shared report",
    category: "File",
    isEnabled: hasApi,
    run: (s, args) => {
      const path = (args as { path?: string } | undefined)?.path;
      s.shell.openDialog({ kind: "openPackage", path });
    },
  });
  r.register({
    id: "package.open.run",
    label: "Open the shared report for viewing",
    category: "File",
    isEnabled: hasApi,
    async run(s, args) {
      const a = (args ?? {}) as { path?: string; accessKey?: string; discard?: boolean; feedUrl?: string; expectedPublisher?: string | null; subscribe?: boolean };
      if (!a.path) throw new Error("Choose a shared report file.");
      if (s.store.getSnapshot().isDirty && a.discard !== true) {
        s.shell.openDialog({ kind: "unsaved", resume: { id: "package.open.run", args: { ...a, discard: true } } });
        return;
      }
      if (s.store.getSnapshot().isDirty) await s.discardUnsavedForExit().catch(() => undefined);
      const opened = await s.publish!.openPackage(a.path, a.accessKey?.trim() || null, a.expectedPublisher ?? null);
      await s.openViewing(opened, a.feedUrl ?? null);
      // a report opened from a feed link is remembered (publisher key pinned) so its updates can be checked
      if (a.feedUrl && a.subscribe !== false) await s.publish!.subscriptionAccept(a.feedUrl, a.path, opened.manifest.reportName, a.accessKey?.trim() || null);
      s.shell.closeDialog();
    },
  });
  r.register({
    id: "link.open",
    label: "Open a biforge:// link",
    category: "File",
    isEnabled: hasApi,
    async run(s, args) {
      const link = (args as { link?: string } | undefined)?.link;
      if (!link) throw new Error("Paste a biforge:// link.");
      await openLink(s, link);
    },
  });
  r.register({
    id: "subscription.check",
    label: "Check for a newer version of this report",
    category: "File",
    isEnabled: (s) => hasApi(s) && s.getSnapshot().viewing?.feedUrl != null,
    async run(s) {
      const v = s.getSnapshot().viewing;
      if (!v?.feedUrl) throw new Error("This report was not opened from a link, so there is nowhere to look for updates.");
      const api = s.publish!;
      const newer = await api.subscriptionCheck(v.packageId);
      if (!newer) {
        s.setMessage(`"${v.reportName}" is up to date (version ${v.version}).`);
        return;
      }
      const key = v.access === "private" ? await api.viewerKey(v.packageId) : null;
      const opened = await api.openPackage(newer.path, key, newer.existingPin);
      await s.openViewing(opened, v.feedUrl);
      await api.subscriptionOpened(v.packageId, opened.manifest.version, newer.path);
      s.setMessage(`Updated "${opened.manifest.reportName}" to version ${opened.manifest.version}.`);
    },
  });
  r.register({
    id: "package.startup",
    label: "Open the file or link BIForge was started with",
    category: "File",
    isEnabled: hasApi,
    async run(s) {
      const arg = await s.publish!.startupOpen();
      if (!arg) return;
      if (arg.startsWith("biforge://")) return openLink(s, arg);
      s.shell.openDialog({ kind: "openPackage", path: arg });
    },
  });
}
