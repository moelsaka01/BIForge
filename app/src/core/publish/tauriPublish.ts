import { invoke } from "@tauri-apps/api/core";
import type { PublishApi } from "./types";

export const tauriPublish: PublishApi = {
  adapters: () => invoke("publish_adapters"),
  targets: (root) => invoke("publish_targets", { root }),
  putTarget: (root, target) => invoke("publish_put_target", { root, target }),
  deleteTarget: (root, targetId) => invoke("publish_delete_target", { root, targetId }),
  validate: (root, targetId) => invoke("publish_validate", { root, targetId }),
  run: (root, project, args) => invoke("publish_run", { root, project, args }),
  unpublish: (root, targetId) => invoke("publish_unpublish", { root, targetId }),
  shareLink: (root, targetId) => invoke("publish_share_link", { root, targetId }),
  accessKey: (root, targetId) => invoke("publish_access_key", { root, targetId }),
  status: (root, targetId) => invoke("publish_status", { root, targetId }),
  audit: (root) => invoke("publish_audit", { root }),
  peek: (path) => invoke("package_peek", { path }),
  openPackage: (path, accessKey, expectedPublisher) => invoke("package_open", { path, accessKey: accessKey ?? null, expectedPublisher: expectedPublisher ?? null }),
  parseLink: (link) => invoke("deep_link_parse", { link }),
  startupOpen: () => invoke("startup_open"),
};
