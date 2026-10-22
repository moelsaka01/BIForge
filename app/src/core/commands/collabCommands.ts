// Editing together and comments. The dialogs only dispatch these ids.
import type { CommandRegistry } from "./registry";
import type { Session } from "../session/session";
import type { CommentAnchor } from "../collab/types";

type Args = Record<string, unknown>;
const str = (a: Args, k: string): string => {
  const v = a[k];
  if (typeof v !== "string" || !v.trim()) throw new Error(`Missing value: ${k}.`);
  return v.trim();
};

const hasCollab = (s: Session) => s.collab !== null;

export function registerCollabCommands(r: CommandRegistry<Session>): void {
  r.register({
    id: "collab.server.open",
    label: "Open a server report for editing together",
    category: "Share",
    isEnabled: (s) => hasCollab(s) && s.host !== null,
    async run(s, args) {
      const a = (args ?? {}) as { connection?: string; workspace?: string; report?: string; discard?: boolean };
      if (s.store.getSnapshot().isDirty && !s.getSnapshot().viewing && a.discard !== true) {
        s.shell.openDialog({ kind: "unsaved", resume: { id: "collab.server.open", args: { ...a, discard: true } } });
        return;
      }
      const opened = await s.host!.openReport(str(a as Args, "connection"), a.workspace ?? null, str(a as Args, "report"));
      if (opened.role === "viewer") throw new Error("Only editors and administrators can edit a report together with others. You can open it for viewing and comment.");
      await s.openServerCoEdit(opened);
      s.shell.closeDialog();
    },
  });
  r.register({
    id: "collab.p2p.host.start",
    label: "Edit together with the guests of the direct session",
    category: "Share",
    isEnabled: (s) => hasCollab(s) && s.store.project !== null && !s.getSnapshot().viewing,
    async run(s, args) {
      const target = str((args ?? {}) as Args, "target");
      await s.startCoEdit({ kind: "p2pHost", target }, "this direct session");
    },
  });
  r.register({
    id: "collab.stop",
    label: "Stop editing together",
    category: "Share",
    isEnabled: (s) => s.getSnapshot().coedit !== null,
    async run(s) {
      await s.stopCoEdit();
      s.setMessage("Stopped editing together. Your project stays as it is now; changes of others no longer arrive.");
    },
  });
  r.register({
    id: "comments.open",
    label: "Comments",
    category: "Share",
    isEnabled: (s) => hasCollab(s) && s.getSnapshot().root !== null,
    async run(s) {
      s.shell.openDialog({ kind: "comments" });
      await s.comments.refresh();
    },
  });
  r.register({ id: "comments.refresh", label: "Refresh the comments", category: "Share", isEnabled: hasCollab, run: (s) => s.comments.refresh() });
  r.register({
    id: "comments.add",
    label: "Add a comment",
    category: "Share",
    isEnabled: hasCollab,
    run: async (s, args) => {
      const a = (args ?? {}) as { text?: string; anchor?: CommentAnchor; parent?: string | null };
      await s.comments.add(a.text ?? "", a.anchor ?? {}, a.parent ?? null);
      const err = s.comments.getSnapshot().error;
      if (err) throw new Error(err);
    },
  });
  r.register({ id: "comments.resolve", label: "Resolve or reopen a comment thread", category: "Share", isEnabled: hasCollab, run: (s, args) => s.comments.resolve(str((args ?? {}) as Args, "id"), (args as { resolved?: boolean }).resolved !== false) });
  r.register({ id: "comments.delete", label: "Delete a comment", category: "Share", isEnabled: hasCollab, run: (s, args) => s.comments.remove(str((args ?? {}) as Args, "id")) });
}
