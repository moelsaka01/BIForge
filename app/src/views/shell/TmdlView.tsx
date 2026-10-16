import { useEffect, useMemo, useState } from "react";
import type { Project } from "../../core/model/types";
import type { TmdlPrinter } from "../../core/model/tmdlPrinter";

/** Read-only TMDL of the model, printed by the same Rust printer that writes the project files. */
export function TmdlView({ project, printer }: { project: Project; printer: TmdlPrinter }) {
  const docs = project.model.tmdl;
  const files = useMemo(() => Object.keys(docs).sort(), [docs]);
  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    printer.print(docs).then(
      (t) => {
        if (!alive) return;
        setText(t);
        setError(null);
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [docs, printer]);

  const current = file && files.includes(file) ? file : (files.find((f) => f === "model.tmdl") ?? files[0] ?? null);
  return (
    <div className="view-content" aria-label="TMDL view">
      <div className="notice-bar">Read-only view of the model files. Editing TMDL here is not implemented; use the other views.</div>
      {error && (
        <div className="notice-bar error" role="alert">
          The TMDL could not be printed: {error}
        </div>
      )}
      <div className="tmdl-view">
        <nav className="tmdl-files" aria-label="TMDL files">
          {files.map((f) => (
            <button key={f} type="button" aria-current={f === current} title={f} onClick={() => setFile(f)}>
              {f}
            </button>
          ))}
        </nav>
        <pre className="tmdl-text" data-testid="tmdl-text" aria-label={current ? `TMDL of ${current}` : "TMDL"}>
          {current ? (text[current] ?? "") : "The model has no files."}
        </pre>
      </div>
    </div>
  );
}
