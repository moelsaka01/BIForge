import { useEffect, useMemo, useState } from "react";
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarBody } from "@fluentui/react-components";
import { DaxEditor } from "../DaxEditor";
import type { EditorFactory } from "../../core/dax/editorTypes";
import type { DaxContext, MarkerSpec } from "../../core/dax/language";
import type { MContext } from "../../core/queries/mLanguage";
import type { MApi } from "../../core/queries/types";

export interface AdvancedEditorProps {
  query: string;
  text: string;
  m: MApi;
  factory: EditorFactory;
  context: MContext;
  /** Saves the text; resolves to an error message or null. */
  onDone(text: string): Promise<string | null>;
  onCancel(): void;
}

/** The whole query as M text, with syntax highlighting, completion and syntax errors marked. */
export function AdvancedEditor({ query, text, m, factory, context, onDone, onCancel }: AdvancedEditorProps) {
  const [value, setValue] = useState(text);
  const [markers, setMarkers] = useState<MarkerSpec[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      m.check(value).then(
        (d) => live && setMarkers(d.map((x) => ({ severity: "error" as const, message: x.message, start: x.start, end: x.end }))),
        () => undefined,
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [m, value]);

  const ctx = useMemo(() => context as unknown as DaxContext, [context]);
  const status = markers.length ? `${markers.length} syntax error${markers.length === 1 ? "" : "s"}: ${markers[0].message}` : "No syntax errors have been detected.";

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => !d.open && onCancel()}>
      <DialogSurface style={{ maxWidth: "92vw", width: 920 }}>
        <DialogBody>
          <DialogTitle>Advanced Editor — {query}</DialogTitle>
          <DialogContent>
            <DaxEditor value={value} onChange={setValue} context={ctx} markers={markers} ariaLabel="Query text" factory={factory} height={420} />
            <div role="status" style={{ fontSize: 12, marginTop: 6, color: markers.length ? "#a4262c" : "#107c10" }}>
              {status}
            </div>
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              appearance="primary"
              disabled={markers.length > 0}
              onClick={async () => {
                const err = await onDone(value);
                if (err) setError(err);
              }}
            >
              Done
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
