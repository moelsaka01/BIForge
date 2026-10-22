// Checking for and installing updates (GitHub Releases, signed). The dialogs only dispatch these ids.
import type { CommandRegistry } from "./registry";
import type { Session } from "../session/session";
import { checkForUpdate, installUpdate } from "../update/update";
import { APP_VERSION } from "../info";

export const UPDATE_OPTION = "updates.checkAtStart";

export function registerUpdateCommands(r: CommandRegistry<Session>): void {
  r.register({
    id: "app.update.check",
    label: "Check for updates",
    category: "Help",
    async run(s, args) {
      const silent = ((args ?? {}) as { silent?: boolean }).silent === true;
      try {
        const u = await checkForUpdate();
        if (!u) {
          if (!silent) s.setMessage(`BIForge ${APP_VERSION} is the newest version.`);
          return;
        }
        s.shell.openDialog({ kind: "update", version: u.version, notes: u.notes });
      } catch (e) {
        // a silent check at start never complains (no network, no release yet)
        if (!silent) throw new Error(`Could not check for updates: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
  r.register({
    id: "app.update.install",
    label: "Install the update and restart",
    category: "Help",
    async run(s) {
      s.setMessage("Downloading the update...");
      await installUpdate((f) => s.setMessage(f === null ? "Downloading the update..." : `Downloading the update: ${Math.round(f * 100)}%`));
    },
  });
}
