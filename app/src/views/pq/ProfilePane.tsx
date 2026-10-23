import { Switch } from "@fluentui/react-components";
import { basisLabel, distributionBars, statsOf } from "../../core/queries/profileText";
import type { ColumnProfile } from "../../core/queries/types";

export interface ProfilePaneProps {
  /** The profile of the selected column; null when no column is selected. */
  profile: ColumnProfile | null;
  all: boolean;
  onAll(v: boolean): void;
  loading: boolean;
  error: string | null;
}

/** Column profile: the statistics of the selected column and its value distribution (the most frequent values). */
export function ProfilePane({ profile, all, onAll, loading, error }: ProfilePaneProps) {
  return (
    <section aria-label="Column profile" style={{ borderTop: "1px solid #c8c6c4", background: "#faf9f8", padding: 8, display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, minHeight: 120, overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{profile ? `Column profile: ${profile.name}` : "Column profile"}</strong>
        <Switch label="Profile the entire data set" checked={all} onChange={(_, d) => onAll(d.checked)} />
      </div>
      {error && (
        <div role="alert" style={{ color: "#a4262c", fontSize: 12 }}>
          {error}
        </div>
      )}
      {!error && !profile && <div style={{ color: "#605e5c", fontSize: 12 }}>{loading ? "Calculating…" : "Select a column to see its statistics and the distribution of its values."}</div>}
      {profile && (
        <div style={{ display: "flex", gap: 24, minHeight: 0 }}>
          <table aria-label="Column statistics" style={{ fontSize: 12, borderCollapse: "collapse" }}>
            <tbody>
              {statsOf(profile).map(([k, v]) => (
                <tr key={k}>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 400, color: "#605e5c", padding: "1px 12px 1px 0" }}>
                    {k}
                  </th>
                  <td style={{ textAlign: "right", padding: "1px 0" }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div aria-label="Value distribution" style={{ flex: 1, minWidth: 0, fontSize: 12 }}>
            {distributionBars(profile).map((b) => (
              <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 6, margin: "1px 0" }}>
                <span style={{ width: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={b.label}>
                  {b.label}
                </span>
                <span aria-hidden style={{ display: "inline-block", height: 10, width: `${Math.max(2, b.width * 100)}%`, maxWidth: "55%", background: "#0f6cbd" }} />
                <span style={{ color: "#605e5c" }}>{b.count.toLocaleString("en-US")}</span>
              </div>
            ))}
            {profile.distinct > profile.top.length && (
              <div style={{ color: "#605e5c" }}>
                Showing the {profile.top.length} most frequent of {profile.distinct.toLocaleString("en-US")} values.
              </div>
            )}
          </div>
        </div>
      )}
      <div style={{ fontSize: 11, color: "#605e5c" }}>{basisLabel(profile ?? undefined, all)}</div>
    </section>
  );
}
