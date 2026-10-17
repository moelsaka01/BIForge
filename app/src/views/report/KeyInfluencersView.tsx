import { useEffect, useMemo, useState } from "react";
import { Select } from "@fluentui/react-components";
import { categoricalInfluences, influenceText, numericInfluences, tableVisual, type Influence, type InfluenceCandidate } from "../../core/report/analysis";
import { influencersStyle } from "../../core/report/analysisStyle";
import { labelOf, num, valueToLit } from "../../core/report/chartData";
import { agg, fieldKey, fieldLabel, litEqual, type FieldRef, type Lit } from "../../core/report/fields";
import { FormatReader } from "../../core/report/formatReader";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { useReport } from "./reportContext";

interface Result {
  list: Influence[];
  /** Every group of every explaining field, for the detail of a selected influence. */
  all: InfluenceCandidate[];
  baseline: number;
  total: number;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Key influencers: for an outcome of the Analyze field (a value of a column) or for the average of a measure, which
 * values of the Explain by fields go with it. Ranked by how many times more likely the outcome is inside the group
 * than outside it. This is a likelihood ratio per value, not the regression model of Power BI Desktop.
 */
export function KeyInfluencersView({ page, visual, width, height }: { page: PageModel; visual: VisualModel; width: number; height: number }) {
  const c = useReport();
  const target = visual.roles.Target?.[0]?.field ?? null;
  const explain = visual.roles.ExplainBy?.map((p) => p.field) ?? [];
  const style = useMemo(() => influencersStyle(new FormatReader(visual.json, c.theme, visual.visualType)), [visual.json, visual.visualType, c.theme]);
  const [values, setValues] = useState<{ lit: Lit; label: string }[]>([]);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [sort, setSort] = useState<"impact" | "count">(style.sort);
  const [res, setRes] = useState<Result | null>(null);
  const [selected, setSelected] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const categorical = target?.kind === "column";

  // the outcomes of a categorical target
  useEffect(() => {
    if (!target || target.kind !== "column") return;
    let off = false;
    void c.data.distinct(c.project, target, c.view.epoch, c.model).then((vs) => {
      if (off) return;
      const list = vs.map((v) => ({ lit: valueToLit(v), label: labelOf(v) }));
      setValues(list);
      setOutcome((cur) => (cur !== null && list.some((x) => x.label === cur) ? cur : (list.find((x) => x.label === style.targetValue)?.label ?? list[0]?.label ?? null)));
    });
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.data, c.project, c.view.epoch, c.model, target && fieldKey(target), style.targetValue]);

  useEffect(() => {
    if (!target || explain.length === 0) return;
    if (categorical && outcome === null) return;
    let off = false;
    setError(null);
    void (async () => {
      try {
        // a case is counted by a column that is there for every case: the target itself, or the first column of its table
        const countCol = target.kind === "measure" ? (c.model.columns(target.table)[0] ?? target.name) : target.name;
        const count = agg(target.table, countCol, 5);
        const run = (fields: FieldRef[], extra: Parameters<typeof c.data.rows>[6] = []) => c.data.rows(c.project, page, visual, c.view, c.model, tableVisual(fields), extra);
        const outcomeFilter = categorical ? [{ name: "outcome", field: target, cond: { kind: "in" as const, values: [values.find((v) => v.label === outcome)!.lit] } }] : [];
        const totalRows = await run([count]);
        const totalN = num(totalRows?.rows[0]?.[0]) ?? 0;
        let totalPos = 0;
        let totalSum = 0;
        if (categorical) totalPos = num((await run([count], outcomeFilter))?.rows[0]?.[0]) ?? 0;
        else {
          const v = num((await run([target]))?.rows[0]?.[0]) ?? 0;
          // an average is already per case; a sum or count is spread over the cases
          totalSum = target.kind === "agg" && target.fn === 1 ? v * totalN : target.kind === "measure" ? v * totalN : v;
        }
        const cands: InfluenceCandidate[] = [];
        for (const e of explain) {
          const n = await run([e, count]);
          const second = categorical ? await run([e, count], outcomeFilter) : await run([e, target]);
          if (!n || !second) continue;
          const fmt = n.query.columns.find((x) => x.kind === "group")?.format ?? null;
          const byKey = new Map(second.rows.map((r) => [r[0].kind + "|" + r[0].text, num(r[1])]));
          cands.push({
            field: e,
            groups: n.rows
              .filter((r) => r[0].kind !== "blank")
              .map((r) => {
                const cases = num(r[1]) ?? 0;
                const v = byKey.get(r[0].kind + "|" + r[0].text) ?? 0;
                const isAverage = target.kind === "agg" ? target.fn === 1 : target.kind === "measure";
                // numeric: the average per case inside the group
                return { lit: valueToLit(r[0]), label: labelOf(r[0], fmt), n: cases, pos: categorical ? (v ?? 0) : isAverage ? (v ?? 0) : cases ? (v ?? 0) / cases : 0 };
              }),
          });
        }
        if (off) return;
        const opt = { minShare: 0.02, limit: 10, sort };
        const list = categorical ? categoricalInfluences(cands, totalN, totalPos, opt) : numericInfluences(cands, totalN, totalSum, opt);
        setRes({ list, all: cands, baseline: categorical ? (totalN ? totalPos / totalN : 0) : totalN ? totalSum / totalN : 0, total: totalN });
        setSelected(0);
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.data, c.project, c.view, c.model, page, visual, target && fieldKey(target), explain.map(fieldKey).join(","), outcome, sort, categorical, values]);

  if (!target || explain.length === 0) return <div role="status" style={{ padding: 12, fontSize: 12 }}>Add the field to analyze and the fields to explain it by.</div>;
  if (error) return <div role="alert" style={{ padding: 12, fontSize: 12, color: "#c50f1f" }}>Cannot load this visual: {error}</div>;
  const targetName = fieldLabel(target);
  const sel = res?.list[selected];
  const detail = sel ? res!.all.find((x) => x.field === sel.field || fieldKey(x.field) === fieldKey(sel.field)) : undefined;
  const maxLift = Math.max(2, ...(res?.list.map((i) => Math.min(i.lift, 10)) ?? [2]));
  return (
    <div style={{ width, height, overflow: "auto", padding: 8, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }} data-testid="key-influencers" aria-label="Key influencers">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600 }}>{categorical ? `What influences ${targetName} to be` : `What increases the average of ${targetName}`}</span>
        {categorical && (
          <Select size="small" aria-label="Outcome" value={outcome ?? ""} onChange={(_, d) => setOutcome(d.value)}>
            {values.map((v) => (
              <option key={v.label} value={v.label}>
                {v.label}
              </option>
            ))}
          </Select>
        )}
        <span style={{ flex: 1 }} />
        <Select size="small" aria-label="Sort influencers by" value={sort} onChange={(_, d) => setSort(d.value as "impact" | "count")}>
          <option value="impact">Impact</option>
          <option value="count">Count</option>
        </Select>
      </div>
      {style.analysis === "topProfiles" && <div role="note" style={{ opacity: 0.7 }}>Top segments are not available yet; the influencers are shown instead.</div>}
      {res && (
        <div style={{ opacity: 0.75 }}>
          {categorical ? `${outcome} is ${pct(res.baseline)} of ${res.total} cases.` : `The average of ${targetName} is ${res.baseline.toFixed(2)} over ${res.total} cases.`}
        </div>
      )}
      <div role="list" aria-label="Top influencers" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {res?.list.map((i, k) => (
          <button key={`${fieldKey(i.field)}|${i.label}`} role="listitem" aria-current={k === selected} onClick={() => setSelected(k)} style={{ textAlign: "left", border: `1px solid ${k === selected ? c.theme.dataColors[0] : "#ccc"}`, background: "transparent", color: "inherit", borderRadius: 3, padding: "4px 6px", cursor: "pointer", font: "inherit" }}>
            <div>{influenceText(i, targetName, categorical ? outcome : null)}</div>
            <div style={{ height: 6, marginTop: 3, width: `${(Math.min(i.lift, 10) / maxLift) * 100}%`, background: c.theme.dataColors[0] }} data-testid="influence-bar" />
          </button>
        ))}
        {res && res.list.length === 0 && <div>No value of the explaining fields makes this {categorical ? "outcome" : "average"} more likely.</div>}
      </div>
      {detail && sel && (
        <div role="group" aria-label={`Detail of ${sel.fieldLabel}`} style={{ borderTop: "1px solid #ddd", paddingTop: 6 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {sel.fieldLabel}: {categorical ? "share with the outcome" : "average"} by value (all cases: {categorical ? pct(res!.baseline) : res!.baseline.toFixed(2)})
          </div>
          {detail.groups
            .map((g) => ({ g, v: categorical ? (g.n ? g.pos / g.n : 0) : g.pos }))
            .sort((a, b) => b.v - a.v)
            .slice(0, 12)
            .map(({ g, v }) => {
              const top = Math.max(...detail.groups.map((x) => (categorical ? (x.n ? x.pos / x.n : 0) : x.pos)), 1e-9);
              return (
                <div key={g.label} style={{ display: "flex", alignItems: "center", gap: 6 }} data-selected={litEqual(g.lit, sel.value)}>
                  <span style={{ width: 120, overflow: "hidden", textOverflow: "ellipsis", fontWeight: litEqual(g.lit, sel.value) ? 700 : 400 }}>{g.label}</span>
                  <div style={{ flex: 1, background: "#eee" }}>
                    <div style={{ width: `${(v / top) * 100}%`, height: 8, background: litEqual(g.lit, sel.value) ? c.theme.dataColors[0] : c.theme.muted }} />
                  </div>
                  <span style={{ width: 56, textAlign: "right" }}>{categorical ? pct(v) : v.toFixed(2)}</span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
