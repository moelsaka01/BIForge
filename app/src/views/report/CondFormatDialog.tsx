import { useState } from "react";
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select } from "@fluentui/react-components";
import { condFormatFromPbir, condFormatToPbir, type CondFormat, type RuleOp } from "../../core/report/condFormat";
import { fieldKey, fieldLabel, type FieldRef } from "../../core/report/fields";
import type { J } from "../../core/report/pbir";

export interface CondFormatDialogProps {
  open: boolean;
  title: string;
  /** Fields the format can be based on (value fields of the visual). */
  fields: FieldRef[];
  /** Current property node, if any. */
  current: J | undefined;
  /** Whether "Field value" (a measure that returns a color) is offered. */
  allowFieldValue?: boolean;
  onApply(node: J | null): void;
  onClose(): void;
}

const OPS: { value: RuleOp; label: string }[] = [
  { value: "gt", label: "is greater than" },
  { value: "ge", label: "is greater than or equal to" },
  { value: "lt", label: "is less than" },
  { value: "le", label: "is less than or equal to" },
  { value: "eq", label: "is" },
];

type Style = "gradient" | "rules" | "fieldValue";

function initial(current: J | undefined, fields: FieldRef[]): CondFormat {
  const c = current ? condFormatFromPbir(current) : null;
  if (c) return c;
  return { kind: "gradient", input: fields[0], min: { color: "#f8d7da" }, max: { color: "#2e9e6b" } };
}

/** Edits a conditional format (color scale, rules, or a color from a field) and returns the PBIR property node. */
export function CondFormatDialog(p: CondFormatDialogProps) {
  const [spec, setSpec] = useState<CondFormat>(() => initial(p.current, p.fields));
  const [error, setError] = useState<string | null>(null);
  if (!p.open) return null;
  const inputKey = fieldKey(spec.input);
  const setStyle = (kind: Style) => {
    const input = spec.input;
    if (kind === "gradient") setSpec({ kind, input, min: { color: "#f8d7da" }, max: { color: "#2e9e6b" } });
    else if (kind === "rules") setSpec({ kind, input, cases: [{ conds: [{ op: "gt", value: 0 }], color: "#2e9e6b" }], fallback: "#d13438" });
    else setSpec({ kind, input });
  };
  const apply = () => {
    if (spec.kind === "rules") {
      if (spec.cases.some((c) => c.conds.some((k) => !Number.isFinite(k.value)))) return setError("Every rule needs a number.");
    }
    if (spec.kind === "gradient" && spec.min.value !== undefined && spec.max.value !== undefined && spec.min.value >= spec.max.value) return setError("The minimum must be smaller than the maximum.");
    setError(null);
    p.onApply(condFormatToPbir(spec));
  };
  const colorInput = (label: string, value: string, onChange: (c: string) => void) => (
    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
      <input type="color" aria-label={label} value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value)} />
      {label}
    </label>
  );
  const numberInput = (label: string, value: number | undefined, onChange: (n: number | undefined) => void, auto = "Lowest value") => (
    <Field label={label} size="small">
      <Input type="number" placeholder={auto} value={value === undefined ? "" : String(value)} onChange={(_, d) => onChange(d.value === "" ? undefined : Number(d.value))} />
    </Field>
  );
  return (
    <Dialog open onOpenChange={(_, d) => !d.open && p.onClose()}>
      <DialogSurface aria-label={p.title}>
        <DialogBody>
          <DialogTitle>{p.title}</DialogTitle>
          <DialogContent style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Format style" size="small">
              <Select aria-label="Format style" value={spec.kind} onChange={(_, d) => setStyle(d.value as Style)}>
                <option value="gradient">Gradient</option>
                <option value="rules">Rules</option>
                {p.allowFieldValue && <option value="fieldValue">Field value</option>}
              </Select>
            </Field>
            <Field label="Based on field" size="small">
              <Select aria-label="Based on field" value={inputKey} onChange={(_, d) => setSpec({ ...spec, input: p.fields.find((f) => fieldKey(f) === d.value) ?? spec.input } as CondFormat)}>
                {p.fields.map((f) => (
                  <option key={fieldKey(f)} value={fieldKey(f)}>
                    {fieldLabel(f)}
                  </option>
                ))}
              </Select>
            </Field>
            {spec.kind === "gradient" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <div>
                  {colorInput("Minimum color", spec.min.color, (color) => setSpec({ ...spec, min: { ...spec.min, color } }))}
                  {numberInput("Minimum value", spec.min.value, (value) => setSpec({ ...spec, min: { color: spec.min.color, ...(value === undefined ? {} : { value }) } }))}
                </div>
                <div>
                  {colorInput("Maximum color", spec.max.color, (color) => setSpec({ ...spec, max: { ...spec.max, color } }))}
                  {numberInput("Maximum value", spec.max.value, (value) => setSpec({ ...spec, max: { color: spec.max.color, ...(value === undefined ? {} : { value }) } }), "Highest value")}
                </div>
                <label style={{ gridColumn: "1 / 3", fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={!!spec.mid}
                    onChange={(e) => setSpec({ ...spec, mid: e.target.checked ? { color: "#fff2cc" } : undefined })}
                  />{" "}
                  Add a middle color
                </label>
                {spec.mid && <div style={{ gridColumn: "1 / 3" }}>{colorInput("Middle color", spec.mid.color, (color) => setSpec({ ...spec, mid: { ...spec.mid!, color } }))}</div>}
                <label style={{ gridColumn: "1 / 3", fontSize: 12 }}>
                  <input type="checkbox" checked={!!spec.nullAsZero} onChange={(e) => setSpec({ ...spec, nullAsZero: e.target.checked })} /> Show blank values as zero
                </label>
              </div>
            )}
            {spec.kind === "rules" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {spec.cases.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }} role="group" aria-label={`Rule ${i + 1}`}>
                    <span style={{ fontSize: 12 }}>If value</span>
                    <Select aria-label="Condition" size="small" value={c.conds[0].op} onChange={(_, d) => setSpec({ ...spec, cases: spec.cases.map((x, j) => (j === i ? { ...x, conds: [{ ...x.conds[0], op: d.value as RuleOp }, ...x.conds.slice(1)] } : x)) })}>
                      {OPS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                    <Input aria-label="Value" size="small" type="number" style={{ width: 90 }} value={String(c.conds[0].value)} onChange={(_, d) => setSpec({ ...spec, cases: spec.cases.map((x, j) => (j === i ? { ...x, conds: [{ ...x.conds[0], value: Number(d.value) }, ...x.conds.slice(1)] } : x)) })} />
                    {colorInput("Color", c.color, (color) => setSpec({ ...spec, cases: spec.cases.map((x, j) => (j === i ? { ...x, color } : x)) }))}
                    <Button size="small" appearance="subtle" aria-label={`Remove rule ${i + 1}`} disabled={spec.cases.length === 1} onClick={() => setSpec({ ...spec, cases: spec.cases.filter((_, j) => j !== i) })}>
                      ✕
                    </Button>
                  </div>
                ))}
                <Button size="small" onClick={() => setSpec({ ...spec, cases: [...spec.cases, { conds: [{ op: "gt", value: 0 }], color: "#e0a800" }] })}>
                  New rule
                </Button>
                {colorInput("Color for all other values", spec.fallback ?? "#888888", (fallback) => setSpec({ ...spec, fallback }))}
              </div>
            )}
            {spec.kind === "fieldValue" && <div style={{ fontSize: 12 }}>The color is the text the field returns, for example #2E9E6B.</div>}
            {error && (
              <div role="alert" style={{ color: "#c50f1f", fontSize: 12 }}>
                {error}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            {p.current && (
              <Button appearance="subtle" onClick={() => p.onApply(null)}>
                Remove
              </Button>
            )}
            <Button onClick={p.onClose}>Cancel</Button>
            <Button appearance="primary" onClick={apply}>
              OK
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
