import type { ValueOut } from "../../core/queries/types";

/** The result of a step that is not a table: one value, or the items of a list or the fields of a record. */
export function ValuePane({ value }: { value: ValueOut }) {
  return (
    <div data-testid="value-pane" style={{ border: "1px solid #d1d1d1", padding: 10, overflow: "auto", flex: 1, minHeight: 0, background: "#faf9f8" }}>
      <div style={{ fontSize: 12, color: "#605e5c", marginBottom: 6 }}>{value.kind === "list" || value.kind === "record" ? value.text : `Value (${value.kind})`}</div>
      {value.items.length > 0 ? (
        <ol style={{ margin: 0, paddingLeft: 28, fontFamily: "Consolas, monospace", fontSize: 13 }}>
          {value.items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ol>
      ) : (
        <div data-testid="value-text" style={{ fontFamily: "Consolas, monospace", fontSize: 18 }}>
          {value.text}
        </div>
      )}
    </div>
  );
}
