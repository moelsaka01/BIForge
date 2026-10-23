// The app window as the shell sees it (title bar buttons, close guard). The Tauri implementation lives in
// tauriWindow.ts; tests and the browser harness use `noWindow`.
export interface WindowApi {
  /** False in a plain browser: the title bar then hides the window buttons. */
  readonly available: boolean;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Full screen on or off (F11). */
  toggleFullscreen(): Promise<void>;
  /** Closes the window for good (no further close request). */
  destroy(): Promise<void>;
  /** Calls `handler` instead of closing when the user closes the window; the handler decides what happens next. */
  onCloseRequested(handler: () => void | Promise<void>): Promise<() => void>;
}

export const noWindow: WindowApi = {
  available: false,
  minimize: async () => undefined,
  toggleMaximize: async () => undefined,
  isMaximized: async () => false,
  toggleFullscreen: async () => undefined,
  destroy: async () => undefined,
  onCloseRequested: async () => () => undefined,
};
