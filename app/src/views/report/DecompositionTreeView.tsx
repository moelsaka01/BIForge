import { useEffect, useMemo, useState } from "react";
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from "@fluentui/react-components";
import { pickAutoSplit, readGroups, stepFilters, tableVisual, type AutoSplit, type Group, type PathStep } from "../../core/report/analysis";
import { treeStyle } from "../../core/report/analysisStyle";
import { fieldKey, fieldLabel, sameField, type FieldRef } from "../../core/report/fields";
import { FormatReader } from "../../core/report/formatReader";
import { formatCompact, formatNumber } from "../../core/report/numberFormat";
import type { PageModel, VisualModel } from "../../core/report/visualDoc";
import { useReport } from "./reportContext";

type Split = FieldRef | AutoSplit;
const isAuto = (s: Split): s is AutoSplit => s === "high" || s === "low";

interface Level {
  field: FieldRef;
  groups: Group[];
  /** The node whose children the next level shows. */
  selected: string | null;
  auto: AutoSplit | null;
}

/**
 * Decomposition tree: the measure of Analyze for everything, then split level by level by a field of Explain by (or by
 * the field whose largest or smallest group stands out). One node per level is open, so the tree is a path.
 */
export function DecompositionTreeView({ page, visual, width, height }: { page: PageModel; visual: VisualModel; width: number; height: number }) {
  const c = useReport();
  const analyze = visual.roles.Analyze?.[0]?.field ?? null;
  const explain = visual.roles.ExplainBy?.map((p) => p.field) ?? [];
  const style = useMemo(() => treeStyle(new FormatReader(visual.json, c.theme, visual.visualType), c.theme), [visual.json, visual.visualType, c.theme]);
  const [spec, setSpec] = useState<Split[]>([]);
  const [picked, setPicked] = useState<(string | null)[]>([]);
  const [root, setRoot] = useState<{ amount: number | null; fmt: string | null } | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [error, setError] = useState<string | null>(null);
  const specKey = `${spec.map((s) => (isAuto(s) ? s : fieldKey(s))).join(",")}|${picked.join(",")}`;

  useEffect(() => {
    if (!analyze) return;
    let off = false;
    void (async () => {
      try {
        const run = (fields: FieldRef[], path: PathStep[]) => c.data.rows(c.project, page, visual, c.view, c.model, tableVisual(fields), stepFilters(path));
        const r = await run([analyze], []);
        if (off) return;
        setRoot({ amount: r && r.rows[0] ? (r.rows[0][0].kind === "blank" ? null : (r.rows[0][0].num ?? null)) : null, fmt: r?.query.columns.find((x) => x.kind === "value")?.format ?? null });
        const out: Level[] = [];
        const path: PathStep[] = [];
        for (let i = 0; i < spec.length; i++) {
          const s = spec[i];
          let field: FieldRef | null = isAuto(s) ? null : s;
          let auto: AutoSplit | null = null;
          let autoGroup: Group | null = null;
          if (isAuto(s)) {
            auto = s;
            const free = explain.filter((e) => !path.some((p) => sameField(p.field, e)));
            const cands = [];
            for (const e of free) {
              const rr = await run([e, analyze], path);
              if (rr) cands.push({ field: e, groups: readGroups(rr.rows, rr.query.columns.find((x) => x.kind === "group")?.format ?? null, 50) });
            }
            const hit = pickAutoSplit(cands, s);
            if (!hit) break;
            field = hit.field;
            autoGroup = hit.group;
          }
          const rr = await run([field!, analyze], path);
          if (off || !rr) return;
          const groups = readGroups(rr.rows, rr.query.columns.find((x) => x.kind === "group")?.format ?? null, style.barsPerLevel);
          const sel = picked[i] ?? autoGroup?.key ?? null;
          out.push({ field: field!, groups, selected: sel && groups.some((g) => g.key === sel) ? sel : null, auto });
          const chosen = groups.find((g) => g.key === sel);
          if (!chosen) break;
          path.push({ field: field!, value: chosen.lit });
        }
        if (!off) {
          setLevels(out);
          setError(null);
        }
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.data, c.project, c.view, c.model, page, visual, analyze && fieldKey(analyze), explain.map(fieldKey).join(","), specKey, style.barsPerLevel]);

  if (!analyze) return <div role="status" style={{ padding: 12, fontSize: 12 }}>Add a measure to Analyze and fields to Explain by.</div>;
  if (error) return <div role="alert" style={{ padding: 12, fontSize: 12, color: "#c50f1f" }}>Cannot load this visual: {error}</div>;
  const fmt = (n: number | null) => (n === null ? "(Blank)" : style.formatString ? formatNumber(n, style.formatString) : formatCompact(n, style.units, style.precision, root?.fmt ?? null));
  const free = (upTo: number) => explain.filter((e) => !levels.slice(0, upTo).some((l) => sameField(l.field, e)));
  const addSplit = (index: number, s: Split) => {
    setSpec((x) => [...x.slice(0, index), s]);
    setPicked((x) => x.slice(0, index));
  };
  const menu = (index: number) => (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button size="small" appearance="subtle" aria-label={`Split by (level ${index + 1})`} disabled={explain.length === 0}>
          +
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItem onClick={() => addSplit(index, "high")}>High value</MenuItem>
          <MenuItem onClick={() => addSplit(index, "low")}>Low value</MenuItem>
          {free(index).map((e) => (
            <MenuItem key={fieldKey(e)} onClick={() => addSplit(index, e)}>
              {fieldLabel(e)}
            </MenuItem>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
  const widthOf = (amount: number | null, parent: number | null, lvl: Level) => {
    const denom = style.scaling === "topNode" ? (root?.amount ?? 0) : style.scaling === "parentNode" ? (parent ?? 0) : Math.max(0, ...lvl.groups.map((g) => g.amount ?? 0));
    return !amount || !denom ? 0 : Math.max(2, Math.min(100, (Math.abs(amount) / Math.abs(denom)) * 100));
  };
  const nodeBox: React.CSSProperties = { border: `1px solid ${style.connector}`, borderRadius: 3, padding: "4px 6px", background: c.theme.background, cursor: "pointer", minWidth: 150, textAlign: "left", font: "inherit", color: "inherit" };
  return (
    <div style={{ width, height, overflow: "auto", display: "flex", alignItems: "flex-start", gap: 24, padding: 8, boxSizing: "border-box" }} data-testid="decomposition-tree" role="tree" aria-label="Decomposition tree">
      <div style={{ display: "flex", flexDirection: "column", gap: style.gap }}>
        <div style={{ ...style.levelTitle, background: style.levelHeaderBackground, padding: "2px 4px" }}>{fieldLabel(analyze)}</div>
        <div role="treeitem" aria-level={1} data-testid="tree-root" style={{ ...nodeBox, cursor: "default" }}>
          <div style={style.label}>{fieldLabel(analyze)}</div>
          <div style={style.valueLabel}>{fmt(root?.amount ?? null)}</div>
        </div>
        {levels.length === 0 && menu(0)}
      </div>
      {levels.map((lvl, i) => {
        const parent = i === 0 ? (root?.amount ?? null) : (levels[i - 1].groups.find((g) => g.key === levels[i - 1].selected)?.amount ?? null);
        return (
          <div key={`${i}-${fieldKey(lvl.field)}`} style={{ display: "flex", flexDirection: "column", gap: style.gap }} data-testid={`tree-level-${i + 1}`}>
            <div style={{ ...style.levelTitle, background: style.levelHeaderBackground, padding: "2px 4px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
              <span>{lvl.auto ? `${fieldLabel(lvl.field)} (${lvl.auto === "high" ? "high" : "low"} value)` : fieldLabel(lvl.field)}</span>
              <Button size="small" appearance="subtle" aria-label={`Remove level ${i + 1}`} onClick={() => {
                  setSpec((x) => x.slice(0, i));
                  setPicked((x) => x.slice(0, i));
                }}>
                ✕
              </Button>
            </div>
            {style.showSubtitles && <div style={style.levelSubtitle}>{fieldLabel(analyze)}</div>}
            {lvl.groups.map((g) => {
              const sel = lvl.selected === g.key;
              return (
                <button
                  key={g.key}
                  role="treeitem"
                  aria-level={i + 2}
                  aria-selected={sel}
                  data-node={g.label}
                  onClick={() => {
                    setPicked((x) => {
                      const next = [...x.slice(0, i), sel && style.clickAction === "toggle" ? null : g.key];
                      return next;
                    });
                  }}
                  style={{ ...nodeBox, borderColor: sel ? style.accent : style.connector, boxShadow: sel ? `0 0 0 1px ${style.accent}` : undefined }}
                >
                  <div style={{ ...style.label, display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>{g.label}</span>
                    <span style={style.valueLabel}>{fmt(g.amount)}</span>
                  </div>
                  <div style={{ background: style.barBackground ?? "transparent", height: 8, marginTop: 3, width: `${style.barWidthPercent}%` }}>
                    <div data-testid="tree-bar" style={{ width: `${widthOf(g.amount, parent, lvl)}%`, height: "100%", background: (g.amount ?? 0) < 0 ? style.negativeColor : style.barColor }} />
                  </div>
                </button>
              );
            })}
            {lvl.groups.length === 0 && <div style={{ fontSize: 12, opacity: 0.7 }}>No data</div>}
            {i === levels.length - 1 && lvl.selected && menu(i + 1)}
          </div>
        );
      })}
    </div>
  );
}
