// The small surface of a code editor that the DAX views use. The real implementation wraps Monaco (monaco.ts);
// tests inject a fake, and the views fall back to a plain text box when the editor cannot be created.

import type { DaxContext, MarkerSpec } from "./language";

export interface EditorHandle {
  getValue(): string;
  setValue(value: string): void;
  setMarkers(markers: MarkerSpec[]): void;
  focus(): void;
  dispose(): void;
}

export interface EditorInit {
  value: string;
  ariaLabel: string;
  /** Read at completion time, so edits to the model are picked up without recreating the editor. */
  getContext(): DaxContext;
  onChange(value: string): void;
}

export type EditorFactory = (container: HTMLElement, init: EditorInit) => Promise<EditorHandle>;
