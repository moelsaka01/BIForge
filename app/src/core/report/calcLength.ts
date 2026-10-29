/** ECharts positions take numbers and percentages only. Small multiples build their panel positions as `calc(25% + 8px)`; this turns them into pixels for a chart of the given size. */
type O = Record<string, unknown>;

const NUM = /^\s*(-?\d+(?:\.\d+)?)(%|px)?\s*/;

/** Evaluates `calc(...)` (nested, with + and -) or a plain length against a total. Returns null when the text is not a length. */
export function calcLength(text: string, total: number): number | null {
  let pos = 0;
  const ws = () => { while (text[pos] === " ") pos++; };
  const operand = (): number | null => {
    ws();
    if (text.startsWith("calc(", pos)) {
      pos += 5;
      const v = sum();
      ws();
      if (text[pos] !== ")") return null;
      pos++;
      return v;
    }
    const m = NUM.exec(text.slice(pos));
    if (!m) return null;
    pos += m[0].length;
    return m[2] === "%" ? (total * Number(m[1])) / 100 : Number(m[1]);
  };
  const sum = (): number | null => {
    let v = operand();
    for (;;) {
      ws();
      const op = text[pos];
      if (v === null || (op !== "+" && op !== "-")) return v;
      pos++;
      const w = operand();
      if (w === null) return null;
      v = op === "+" ? v + w : v - w;
    }
  };
  const v = sum();
  ws();
  return v !== null && pos === text.length ? v : null;
}

const HORIZONTAL = new Set(["left", "right", "width"]);

/** The option with every `calc(...)` position of its grids and titles replaced by pixels; the same object when there is none. */
export function resolveCalc(option: O, width: number, height: number): O {
  let changed = false;
  const fix = (items: unknown): unknown => {
    if (!Array.isArray(items)) return items;
    return items.map((item: O) => {
      let copy: O | null = null;
      for (const [k, v] of Object.entries(item)) {
        if (typeof v !== "string" || !v.startsWith("calc(")) continue;
        const n = calcLength(v, HORIZONTAL.has(k) ? width : height);
        if (n === null) continue;
        copy ??= { ...item };
        copy[k] = n;
      }
      if (copy) changed = true;
      return copy ?? item;
    });
  };
  const grid = fix(option.grid);
  const title = fix(option.title);
  return changed ? { ...option, grid, title } : option;
}
