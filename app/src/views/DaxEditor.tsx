import { useEffect, useRef, useState } from "react";
import type { EditorFactory, EditorHandle } from "../core/dax/editorTypes";
import type { DaxContext, MarkerSpec } from "../core/dax/language";

export interface DaxEditorProps {
  value: string;
  onChange(value: string): void;
  context: DaxContext;
  markers: MarkerSpec[];
  ariaLabel: string;
  /** Creates the code editor (Monaco in the app). When it cannot be created a plain text box takes over. */
  factory: EditorFactory;
  height?: number;
}

/**
 * A DAX code editor: syntax highlighting, IntelliSense and error squiggles come from the factory's editor; this
 * component only keeps it in sync with React state. If the editor fails to load, a plain text box is shown so the
 * expression can still be edited (and the failure is visible).
 */
export function DaxEditor(p: DaxEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);
  const latest = useRef(p);
  latest.current = p;
  // Text the editor itself produced that has not come back through props yet. While the user types quickly the props lag
  // behind the editor ("S" arrives after "SU" was typed); writing that stale text back would reset the caret to the start.
  const emitted = useRef<string[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    let disposed = false;
    const el = host.current;
    if (!el) return;
    p.factory(el, {
      value: latest.current.value,
      ariaLabel: latest.current.ariaLabel,
      getContext: () => latest.current.context,
      onChange: (v) => {
        emitted.current.push(v);
        latest.current.onChange(v);
      },
    })
      .then((h) => {
        if (disposed) {
          h.dispose();
          return;
        }
        handle.current = h;
        h.setValue(latest.current.value);
        h.setMarkers(latest.current.markers);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (disposed) return;
        setFailure(e instanceof Error ? e.message : String(e));
        setState("failed");
      });
    return () => {
      disposed = true;
      handle.current?.dispose();
      handle.current = null;
    };
    // the editor is created once per mount; later props reach it through the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.factory]);

  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const i = emitted.current.indexOf(p.value);
    if (i >= 0) {
      emitted.current.splice(0, i + 1); // the editor's own text coming back, possibly stale: nothing to write
      return;
    }
    emitted.current = [];
    h.setValue(p.value);
  }, [p.value, state]);

  useEffect(() => {
    handle.current?.setMarkers(p.markers);
  }, [p.markers, state]);

  const height = p.height ?? 180;
  if (state === "failed") {
    return (
      <div>
        <div role="alert" style={{ fontSize: 12, color: "#a4262c" }}>
          The code editor could not be loaded ({failure}); using a plain text box.
        </div>
        <textarea aria-label={p.ariaLabel} value={p.value} onChange={(e) => p.onChange(e.target.value)} style={{ width: "100%", height, fontFamily: "Consolas, monospace", fontSize: 14, boxSizing: "border-box" }} />
      </div>
    );
  }
  return <div ref={host} data-testid="dax-editor-host" data-state={state} style={{ height, border: "1px solid #c8c6c4" }} />;
}
