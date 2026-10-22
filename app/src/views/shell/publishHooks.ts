import { useSyncExternalStore } from "react";
import { useEnv } from "./ShellContext";

/** The Publish & Share state, for components that live in their own file. */
export function usePublishUiState() {
  const { session } = useEnv();
  const ui = session.publishUi;
  return { ui, state: useSyncExternalStore(ui.subscribe, ui.getSnapshot) };
}
