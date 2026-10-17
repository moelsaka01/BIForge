import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Dialogs, ProjectIO } from "./session";
import { storedIO } from "../report/storage";
import type { Project, SaveReport } from "../model/types";

export const tauriIO: ProjectIO = storedIO({
  newProject: (root, name) => invoke<Project>("new_project", { root, name }),
  openProject: (pbipPath) => invoke<Project>("open_project", { pbipPath }),
  saveProject: (root, project) => invoke<SaveReport>("save_project", { root, project }),
  writeRecovery: (root, project) => invoke<void>("write_recovery", { root, project }),
  readRecovery: (root) => invoke<Project | null>("read_recovery", { root }),
  clearRecovery: (root) => invoke<void>("clear_recovery", { root }),
  writeSampleData: (root) => invoke<string[]>("write_sample_data", { root }),
  readImage: (path) => invoke<string>("read_image_data_uri", { path }),
  openUrl: (url) => invoke<void>("open_url", { url }),
});

// real-window UI test seam (see test_pick in commands.rs): answers from BIFORGE_TEST_PICKS when it is set
const testPick = async (): Promise<string | null> => {
  try {
    return await invoke<string | null>("test_pick");
  } catch {
    return null;
  }
};

export const tauriDialogs: Dialogs = {
  pickPbip: async () => {
    const t = await testPick();
    if (t) return t;
    const r = await open({ multiple: false, directory: false, filters: [{ name: "BIForge / Power BI project", extensions: ["pbip"] }] });
    return typeof r === "string" ? r : null;
  },
  pickFile: async (name, extensions) => {
    const t = await testPick();
    if (t) return t;
    const r = await open({ multiple: false, directory: false, filters: [{ name, extensions }] });
    return typeof r === "string" ? r : null;
  },
  pickFolder: async () => {
    const t = await testPick();
    if (t) return t;
    const r = await open({ multiple: false, directory: true });
    return typeof r === "string" ? r : null;
  },
};
