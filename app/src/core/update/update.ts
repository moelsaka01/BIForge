// Updates through the Tauri updater against BIForge's GitHub Releases (`latest.json`). The download is verified with the
// updater public key in tauri.conf.json before anything is installed; the private key exists only as a GitHub secret.
export interface UpdateInfo {
  version: string;
  notes: string;
}

interface Pending {
  version: string;
  body?: string;
  downloadAndInstall(onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void>;
}

let pending: Pending | null = null;

/** Asks GitHub whether a newer version exists. Returns null when this one is the newest. Throws when there is no network. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const u = (await check()) as Pending | null;
  pending = u;
  return u ? { version: u.version, notes: u.body ?? "" } : null;
}

/** Downloads the update found by the last check, installs it and restarts BIForge. `onProgress` gets 0..1 when the size is known. */
export async function installUpdate(onProgress: (fraction: number | null) => void): Promise<void> {
  if (!pending) throw new Error("There is no update to install. Check for updates first.");
  let total = 0;
  let got = 0;
  await pending.downloadAndInstall((e) => {
    if (e.event === "Started") total = e.data?.contentLength ?? 0;
    if (e.event === "Progress") {
      got += e.data?.chunkLength ?? 0;
      onProgress(total ? Math.min(1, got / total) : null);
    }
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
