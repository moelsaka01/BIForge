import { invoke } from "@tauri-apps/api/core";
import type { HostApi } from "./types";

export const tauriHost: HostApi = {
  status: () => invoke("host_status"),
  start: (lan, port, publicUrl, tls) => invoke("host_start", { lan, port, publicUrl, tls }),
  stop: () => invoke("host_stop"),
  join: (linkOrUrl, invite, displayName, pin) => invoke("server_join", { linkOrUrl, invite, displayName, pin: pin ?? null }),
  connectAdmin: (url, adminToken, pin) => invoke("server_connect_admin", { url, adminToken, pin }),
  connections: () => invoke("server_connections"),
  forget: (id) => invoke("server_forget", { id }),
  op: (connection, op, args) => invoke("server_op", { connection, op, args }),
  openReport: (connection, workspace, report) => invoke("server_open_report", { connection, workspace, report }),
  p2pHostState: (targetId) => invoke("p2p_host_state", { targetId }),
  p2pApprove: (targetId, request, role) => invoke("p2p_approve", { targetId, request, role }),
  p2pDeny: (targetId, request) => invoke("p2p_deny", { targetId, request }),
  p2pRevoke: (targetId, endpointId) => invoke("p2p_revoke", { targetId, endpointId }),
  p2pTakePush: (targetId, push) => invoke("p2p_take_push", { targetId, push }),
  p2pJoin: (code, name) => invoke("p2p_join", { code, name }),
  p2pGuestState: (id) => invoke("p2p_guest_state", { id }),
  p2pPush: (id, path) => invoke("p2p_push", { id, path }),
  p2pLeave: (id) => invoke("p2p_leave", { id }),
};
