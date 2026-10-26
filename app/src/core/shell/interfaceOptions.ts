// Options that change how the whole window behaves: the size of the interface and the quiet check for a new release.
import type { OptionValue } from "./settings";

/** The scale of the interface in percent, from Options > Interface (50 to 200, 100 when not set or not a number). */
export function interfaceZoom(options: Record<string, OptionValue>): number {
  const z = options["interface.zoom"];
  return typeof z === "number" && Number.isFinite(z) ? Math.min(200, Math.max(50, Math.round(z))) : 100;
}

/** Scales the element (the document) by the option; 100 removes the scaling. */
export function applyInterfaceZoom(el: HTMLElement, options: Record<string, OptionValue>): void {
  const z = interfaceZoom(options);
  if (z === 100) el.style.removeProperty("zoom");
  else el.style.setProperty("zoom", String(z / 100));
}

/** True unless the person switched the check off (Options > Updates, or About). */
export const shouldCheckForUpdates = (options: Record<string, OptionValue>): boolean => options["updates.checkAtStart"] !== false;
