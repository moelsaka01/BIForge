import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Input, MessageBar, MessageBarBody, Select, Textarea } from "@fluentui/react-components";
import type { DialogAction, DialogDef, Field, Option, Values } from "../../core/queries/dialogs";

export interface FormDialogProps {
  def: DialogDef;
  pickFile(name: string, extensions: string[]): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  /** Runs the built action; resolves to an error message or null when it worked. */
  onSubmit(action: DialogAction): Promise<string | null>;
  onCancel(): void;
  /** Called when a field changes, so the owner can load more choices (for example the sheets of a workbook). */
  onValues?(values: Values): void;
}

function defaultsOf(fields: Field[], into: Values = {}): Values {
  for (const f of fields) {
    if (into[f.key] !== undefined) continue;
    if (f.kind === "rows") into[f.key] = (f.defaultRows ?? Array.from({ length: f.min ?? 0 }, () => ({}))).map((r) => ({ ...defaultsOf(f.fields), ...r }));
    else if (f.kind === "check") into[f.key] = f.default ?? false;
    else if (f.kind === "multi") into[f.key] = f.default ?? [];
    else if (f.kind === "number") into[f.key] = f.default ?? "";
    else if (f.kind === "select") {
      const opts = typeof f.options === "function" ? [] : f.options;
      into[f.key] = f.default ?? opts[0]?.value ?? "";
    } else if (f.kind === "text" || f.kind === "textarea") into[f.key] = f.default ?? "";
    else into[f.key] = "";
  }
  return into;
}

function optionsOf(f: Extract<Field, { kind: "select" }>, values: Values): Option[] {
  return typeof f.options === "function" ? f.options(values) : f.options;
}

/** A select whose choices depend on other fields shows its first choice when its value is no longer one of them; the value must follow. */
function fixSelects(fields: Field[], v: Values): Values {
  const out = { ...v };
  for (const f of fields) {
    if (f.kind !== "select") continue;
    const opts = optionsOf(f, out);
    if (opts.length > 0 && !opts.some((o) => o.value === out[f.key])) out[f.key] = opts[0].value;
  }
  return out;
}

export function FormDialog({ def, pickFile, pickFolder, onSubmit, onCancel, onValues }: FormDialogProps) {
  const [raw, setValues] = useState<Values>(() => defaultsOf(def.fields));
  const values = fixSelects(def.fields, raw);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seen = useRef(def);

  // a rebuilt definition (for example new sheet choices) keeps what was typed and adds defaults for new fields
  useEffect(() => {
    if (seen.current !== def) {
      seen.current = def;
      setValues((v) => defaultsOf(def.fields, { ...v }));
    }
  }, [def]);

  const change = (patch: Values) => {
    setValues((v) => {
      const next = { ...fixSelects(def.fields, v), ...patch };
      onValues?.(next);
      return next;
    });
  };

  const submit = async () => {
    setError(null);
    let action: DialogAction;
    try {
      action = def.build(values);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setBusy(true);
    try {
      const err = await onSubmit(action);
      if (err) setError(err);
    } finally {
      setBusy(false);
    }
  };

  const render = (f: Field, val: unknown, set: (v: unknown) => void, scope: Values) => {
    switch (f.kind) {
      case "text":
        return <Input aria-label={f.label} value={String(val ?? "")} placeholder={f.placeholder} onChange={(_, d) => set(d.value)} />;
      case "number":
        return <Input aria-label={f.label} type="number" value={String(val ?? "")} min={f.min} onChange={(_, d) => set(d.value)} />;
      case "select": {
        const opts = optionsOf(f, scope);
        return (
          <Select aria-label={f.label} value={String(val ?? "")} onChange={(_, d) => set(d.value)}>
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        );
      }
      case "multi": {
        const cur = new Set((val as string[]) ?? []);
        return (
          <div role="group" aria-label={f.label} style={{ maxHeight: 160, overflow: "auto", border: "1px solid #e1dfdd", padding: 4 }}>
            {f.options.map((o) => (
              <div key={o.value}>
                <Checkbox
                  label={o.label}
                  checked={cur.has(o.value)}
                  onChange={(_, d) => {
                    const next = new Set(cur);
                    if (d.checked) next.add(o.value);
                    else next.delete(o.value);
                    set(f.options.map((x) => x.value).filter((v) => next.has(v)));
                  }}
                />
              </div>
            ))}
          </div>
        );
      }
      case "textarea":
        return <Textarea aria-label={f.label} rows={f.rows ?? 4} value={String(val ?? "")} placeholder={f.placeholder} onChange={(_, d) => set(d.value)} style={{ width: "100%", fontFamily: "Consolas, monospace" }} />;
      case "check":
        return <Checkbox label={f.label} checked={!!val} onChange={(_, d) => set(!!d.checked)} />;
      case "file":
        return (
          <div style={{ display: "flex", gap: 6 }}>
            <Input aria-label={f.label} value={String(val ?? "")} onChange={(_, d) => set(d.value)} style={{ flex: 1 }} />
            <Button
              size="small"
              onClick={async () => {
                const p = await pickFile(f.name, f.extensions);
                if (p) set(p);
              }}
            >
              Browse…
            </Button>
          </div>
        );
      case "folder":
        return (
          <div style={{ display: "flex", gap: 6 }}>
            <Input aria-label={f.label} value={String(val ?? "")} onChange={(_, d) => set(d.value)} style={{ flex: 1 }} />
            <Button
              size="small"
              onClick={async () => {
                const p = await pickFolder();
                if (p) set(p);
              }}
            >
              Browse…
            </Button>
          </div>
        );
      case "rows": {
        const rows = (val as Values[]) ?? [];
        return (
          <div style={{ display: "grid", gap: 6 }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "end" }} data-testid={`${f.key}-row`}>
                {f.fields.map((sf) => (
                  <label key={sf.key} style={{ display: "grid", gap: 2, flex: 1, fontSize: 12 }}>
                    {sf.label}
                    {render(sf, r[sf.key], (nv) => set(rows.map((x, j) => (j === i ? { ...x, [sf.key]: nv } : x))), r)}
                  </label>
                ))}
                <Button size="small" aria-label={`Remove ${f.label} ${i + 1}`} disabled={rows.length <= (f.min ?? 0)} onClick={() => set(rows.filter((_, j) => j !== i))}>
                  ✕
                </Button>
              </div>
            ))}
            <div>
              <Button size="small" onClick={() => set([...rows, defaultsOf(f.fields)])}>
                {f.addLabel}
              </Button>
            </div>
          </div>
        );
      }
    }
  };

  return (
    <Dialog open modalType="modal" onOpenChange={(_, d) => !d.open && onCancel()}>
      <DialogSurface style={{ maxWidth: 640, width: "92vw" }}>
        <DialogBody>
          <DialogTitle>{def.title}</DialogTitle>
          <DialogContent>
            <div style={{ display: "grid", gap: 10 }}>
              {def.fields.map((f) =>
                f.kind === "check" ? (
                  <div key={f.key}>{render(f, values[f.key], (v) => change({ [f.key]: v }), values)}</div>
                ) : f.kind === "multi" || f.kind === "rows" ? (
                  <div key={f.key} style={{ display: "grid", gap: 3, fontSize: 13 }}>
                    <span>{f.label}</span>
                    {render(f, values[f.key], (v) => change({ [f.key]: v }), values)}
                  </div>
                ) : (
                  <label key={f.key} style={{ display: "grid", gap: 3, fontSize: 13 }}>
                    <span>{f.label}</span>
                    {render(f, values[f.key], (v) => change({ [f.key]: v }), values)}
                  </label>
                ),
              )}
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={busy} onClick={() => void submit()}>
              {def.submitLabel}
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
