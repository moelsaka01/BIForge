import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WindowApi } from "./windowApi";

/** Window controls through Tauri. Only used inside the real app window. */
export const tauriWindow: WindowApi = {
  available: true,
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  destroy: () => getCurrentWindow().destroy(),
  onCloseRequested: (handler) =>
    getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault();
      await handler();
    }),
};
