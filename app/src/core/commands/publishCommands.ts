// Publish & Share and viewing mode. The dialog only dispatches these ids.
import type { CommandRegistry } from "./registry";
import type { Session } from "../session/session";
import type { AccessLevel } from "../publish/types";

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
  /^file\.(close|open|new|newBlank|newSample|newSample\.run)$/,
  /^package\./,
  /^link\./,
];

export function viewingGuard(s: Session, id: string): string | null {
  if (!s.getSnapshot().viewing) return null;
  return VIEWING_ALLOWED.some((r) => r.test(id)) ? null : VIEWING_MESSAGE;
}

async function openLink(s: Session, link: string): Promise<void> {
  const parsed = await s.publish!.parseLink(link);
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
      const a = (args ?? {}) as { path?: string; accessKey?: string; discard?: boolean };
      if (!a.path) throw new Error("Choose a shared report file.");
      if (s.store.getSnapshot().isDirty && a.discard !== true) {
        s.shell.openDialog({ kind: "unsaved", resume: { id: "package.open.run", args: { ...a, discard: true } } });
        return;
      }
      if (s.store.getSnapshot().isDirty) await s.discardUnsavedForExit().catch(() => undefined);
      const opened = await s.publish!.openPackage(a.path, a.accessKey?.trim() || null, null);
      await s.openViewing(opened);
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
