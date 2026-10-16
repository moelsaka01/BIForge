import { Calculator16Regular, Calendar16Regular } from "@fluentui/react-icons";

export type FieldIconKind = "sigma" | "calendar" | "measure" | "none";

/**
 * The small icon Power BI shows next to a field instead of its type name: Σ for a number that is summarized
 * (summarizeBy is not "none"), a calendar for dates and times, a calculator for a measure. Text, true/false and
 * numeric key columns (summarizeBy none) show no icon.
 */
export function fieldIconKind(dataType: string | null, summarizeBy: string | null, isMeasure = false): FieldIconKind {
  if (isMeasure) return "measure";
  if (dataType === "dateTime") return "calendar";
  if ((dataType === "int64" || dataType === "double" || dataType === "decimal") && summarizeBy !== "none") return "sigma";
  return "none";
}

export const FIELD_ICON_LABEL: Record<FieldIconKind, string> = { sigma: "Summarized number", calendar: "Date", measure: "Measure", none: "" };

/** A fixed-size slot so names line up whether or not a field has an icon. */
export function FieldIcon({ kind }: { kind: FieldIconKind }) {
  const style = { width: 16, height: 16, flex: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", opacity: 0.8 } as const;
  if (kind === "none") return <span style={style} aria-hidden data-field-icon="none" />;
  return (
    <span style={style} role="img" aria-label={FIELD_ICON_LABEL[kind]} data-field-icon={kind}>
      {kind === "sigma" ? <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1 }}>Σ</span> : kind === "calendar" ? <Calendar16Regular /> : <Calculator16Regular />}
    </span>
  );
}
