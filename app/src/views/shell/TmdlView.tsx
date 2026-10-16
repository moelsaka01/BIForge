import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@fluentui/react-components";
import type { Project } from "../../core/model/types";
import type { TmdlPrinter } from "../../core/model/tmdlPrinter";
import { useEnv, useShellState } from "./ShellContext";

/**
 * The TMDL of the model, printed by the Rust printer that writes the project files. A file can be edited as text:
 * Apply parses it with the Rust TMDL parser and, if it is valid, replaces the file through the `model.setTmdlDocument`
 * command, so the edit is one undo step like any other change. Errors name the line and change nothing.
 */
export function TmdlView({ project, printer }: { project: Project; printer: TmdlPrinter }) {
  const env = useEnv();
  const { applyTmdlTick } = useShellState();
  const docs = project.model.tmdl;
  const files = useMemo(() => Object.keys(docs).sort(), [docs]);
  const [file, setFile] = useState<string | null>(null);
  const [printed, setPrinted] = useState<Record<string, string>>({});
  /** Unapplied text per file. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    printer.print(docs).then(
      (t) => {
        if (!alive) return;
        setPrinted(t);
        // a draft that now equals the printed text (after Apply, Undo or Redo) is no longer a draft
        setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k, v]) => t[k] !== undefined && v !== t[k])));
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [docs, printer]);

  const current = file && files.includes(file) ? file : (files.find((f) => f === "model.tmdl") ?? files[0] ?? null);
  const shown = current ? (drafts[current] ?? printed[current] ?? "") : "";
  const dirty = current !== null && drafts[current] !== undefined;

  const apply = async () => {
    if (!current || drafts[current] === undefined) return;
    setMessage(null);
    try {
      const document = await printer.parse(drafts[current]);
      const ok = await env.run("model.setTmdlDocument", { path: current, document });
      if (ok) {
        setError(null);
        setMessage(`Applied ${current}.`);
      }
    } catch (e) {
      setError(`${current}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // the ribbon's Apply changes
  const seen = useRef(applyTmdlTick);
  useEffect(() => {
    if (applyTmdlTick !== seen.current) {
      seen.current = applyTmdlTick;
      void apply();
    }
  });

  return (
    <div className="view-content" aria-label="TMDL view">
      <div className="notice-bar" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ flex: 1 }}>Edit the text of a model file, then Apply. A change that does not parse is refused and the model stays as it is; an applied change can be undone.</span>
        <Button size="small" appearance="primary" disabled={!dirty} onClick={() => void apply()}>
          Apply
        </Button>
        <Button
          size="small"
          disabled={!dirty}
          onClick={() => {
            setDrafts(({ [current!]: _gone, ...rest }) => rest);
            setError(null);
          }}
        >
          Revert
        </Button>
      </div>
      {error && (
        <div className="notice-bar error" role="alert">
          {error}
        </div>
      )}
      {message && !error && (
        <div className="notice-bar" role="status">
          {message}
        </div>
      )}
      <div className="tmdl-view">
        <nav className="tmdl-files" aria-label="TMDL files">
          {files.map((f) => (
            <button key={f} type="button" aria-current={f === current} title={f} onClick={() => setFile(f)}>
              {f}
              {drafts[f] !== undefined ? " •" : ""}
            </button>
          ))}
        </nav>
        {current ? (
          <textarea
            className="tmdl-text"
            data-testid="tmdl-text"
            aria-label={`TMDL of ${current}`}
            spellCheck={false}
            value={shown}
            onChange={(e) => {
              setMessage(null);
              setDrafts((d) => ({ ...d, [current]: e.target.value }));
            }}
            style={{ resize: "none", border: "none", font: "12px/1.5 Consolas, monospace", background: "transparent", color: "inherit", outline: "none", width: "100%", minHeight: 0 }}
          />
        ) : (
          <div className="tmdl-text">The model has no files.</div>
        )}
      </div>
    </div>
  );
}
