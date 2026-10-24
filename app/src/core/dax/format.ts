// BIForge's DAX formatter (local, no service): keywords on their own lines, operators and commas spaced, and function calls that
// do not fit in one line broken one argument per line. The tokens are never changed, only the white space between them, so
// the formatted text means exactly what the original did (the test compares token streams). Comments are kept on their own lines.

const WIDTH = 72;
const INDENT = "    ";

export type Tok = { at: number; end: number; k: "ws" | "comment" | "str" | "table" | "col" | "num" | "id" | "op" | "open" | "close" | "comma" | "lbrace" | "rbrace"; s: string; glued: boolean };

const RULES: [Tok["k"], RegExp][] = [
  ["comment", /^(\/\/[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)/],
  ["str", /^"(?:[^"]|"")*"/],
  ["table", /^'(?:[^']|'')*'/],
  ["col", /^\[(?:[^\]]|\]\])*\]/],
  ["num", /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/],
  ["id", /^[A-Za-z_\u0080-￿][\w.\u0080-￿]*/],
  ["op", /^(?:&&|\|\||<=|>=|<>|==|[+\-*/^=<>&!:])/],
  ["open", /^\(/],
  ["close", /^\)/],
  ["lbrace", /^\{/],
  ["rbrace", /^\}/],
  ["comma", /^,/],
];

export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let space = true;
  while (i < text.length) {
    const rest = text.slice(i);
    const w = /^\s+/.exec(rest);
    if (w) {
      i += w[0].length;
      space = true;
      continue;
    }
    const hit = RULES.map(([k, re]) => [k, re.exec(rest)] as const).find(([, m]) => m);
    if (!hit) throw new Error(`Unexpected character "${rest[0]}" at position ${i}.`);
    const [k, m] = hit;
    out.push({ k, s: m![0], glued: !space, at: i, end: i + m![0].length });
    i += m![0].length;
    space = false;
  }
  return out;
}

type Item =
  | { t: "atom"; s: string; glued: boolean; kind: Tok["k"] }
  | { t: "comment"; s: string }
  | { t: "call"; name: string; args: Item[][]; glued: boolean }
  | { t: "paren"; seq: Item[] }
  | { t: "brace"; elems: Item[][] };

function parse(tokens: Tok[]): Item[] {
  let p = 0;
  const seq = (stop: Tok["k"][]): Item[] => {
    const out: Item[] = [];
    while (p < tokens.length && !stop.includes(tokens[p].k)) {
      const t = tokens[p++];
      if (t.k === "close") throw new Error("There is a closing parenthesis without an opening one.");
      if (t.k === "rbrace") throw new Error("There is a closing brace without an opening one.");
      if (t.k === "comment") out.push({ t: "comment", s: t.s });
      else if (t.k === "open") {
        const prev = out[out.length - 1];
        const inner = list(["close"]);
        expect("close");
        if (prev && prev.t === "atom" && prev.kind === "id" && !/^(VAR|RETURN|NOT|IN|EVALUATE|DEFINE|MEASURE|ORDER|BY|ASC|DESC|AND|OR)$/i.test(prev.s) && t.glued) {
          out.pop();
          out.push({ t: "call", name: prev.s, args: inner, glued: prev.glued });
        } else if (prev && prev.t === "atom" && prev.kind === "id" && !/^(VAR|RETURN|NOT|IN|EVALUATE|DEFINE|MEASURE|ORDER|BY|ASC|DESC|AND|OR)$/i.test(prev.s)) {
          out.pop();
          out.push({ t: "call", name: prev.s, args: inner, glued: prev.glued });
        } else out.push({ t: "paren", seq: inner.length === 1 ? inner[0] : inner.flat() });
      } else if (t.k === "lbrace") {
        const elems = list(["rbrace"]);
        expect("rbrace");
        out.push({ t: "brace", elems });
      } else out.push({ t: "atom", s: t.s, glued: t.glued, kind: t.k });
    }
    return out;
  };
  const list = (stop: Tok["k"][]): Item[][] => {
    const parts: Item[][] = [];
    if (p < tokens.length && stop.includes(tokens[p].k)) return parts;
    for (;;) {
      parts.push(seq([...stop, "comma"]));
      if (p < tokens.length && tokens[p].k === "comma") p++;
      else break;
    }
    return parts;
  };
  const expect = (k: Tok["k"]) => {
    if (tokens[p]?.k !== k) throw new Error(k === "close" ? "A parenthesis is not closed." : "A brace is not closed.");
    p++;
  };
  const all = seq([]);
  if (p < tokens.length) throw new Error(tokens[p].k === "close" ? "There is a closing parenthesis without an opening one." : "There is a closing brace without an opening one.");
  return all;
}

const isOp = (i?: Item) => i?.t === "atom" && (i.kind === "op" || /^(AND|OR|IN|NOT)$/i.test(i.s));
const pad = (n: number) => INDENT.repeat(n);

function hasComment(items: Item[]): boolean {
  return items.some((i) => i.t === "comment" || (i.t === "call" && i.args.some(hasComment)) || (i.t === "paren" && hasComment(i.seq)) || (i.t === "brace" && i.elems.some(hasComment)));
}

function inlineSeq(items: Item[]): string {
  let out = "";
  items.forEach((it, idx) => {
    const text = inlineItem(it);
    const prev = items[idx - 1];
    const afterUnary = prev?.t === "atom" && (prev.s === "-" || prev.s === "+") && (!items[idx - 2] || isOp(items[idx - 2]));
    const glue = idx > 0 && ((it.t === "atom" && it.kind === "col" && it.glued) || afterUnary);
    if (idx > 0) out += glue ? "" : " ";
    out += text;
  });
  return out;
}

function inlineItem(it: Item): string {
  switch (it.t) {
    case "atom":
      return it.s;
    case "comment":
      return it.s;
    case "call":
      return `${it.name}(${it.args.map(inlineSeq).join(", ")})`;
    case "paren":
      return `(${inlineSeq(it.seq)})`;
    case "brace":
      return `{${it.elems.map(inlineSeq).join(", ")}}`;
  }
}

/** A sequence at an indent level: on one line when it fits and has no comment, otherwise its calls are broken. */
function renderSeq(items: Item[], level: number, used = 0): string {
  const vars = items.findIndex((i) => i.t === "atom" && i.kind === "id" && /^(VAR|RETURN)$/i.test(i.s));
  if (vars >= 0 && (items[vars] as { s: string }).s.toUpperCase() === "VAR" && vars === 0) return renderVars(items, level);
  const flat = inlineSeq(items);
  if (!hasComment(items) && pad(level).length + used + flat.length <= WIDTH) return flat;
  let out = "";
  items.forEach((it, idx) => {
    const prev = items[idx - 1];
    const afterUnary = prev?.t === "atom" && (prev.s === "-" || prev.s === "+") && (!items[idx - 2] || isOp(items[idx - 2]));
    const glue = idx > 0 && ((it.t === "atom" && it.kind === "col" && it.glued) || afterUnary);
    const sep = idx === 0 ? "" : glue ? "" : prev?.t === "comment" ? "\n" + pad(level) : " ";
    if (it.t === "comment") {
      out += (idx === 0 ? "" : "\n" + pad(level)) + it.s;
      return;
    }
    out += sep + renderItem(it, level);
  });
  return out;
}

function renderItem(it: Item, level: number): string {
  if (it.t === "call") {
    const flat = inlineItem(it);
    if (!hasComment([it]) && pad(level).length + flat.length <= WIDTH) return flat;
    if (it.args.length === 0) return `${it.name}()`;
    return `${it.name}(\n${it.args.map((a) => pad(level + 1) + renderSeq(a, level + 1)).join(",\n")}\n${pad(level)})`;
  }
  if (it.t === "paren") {
    const flat = inlineItem(it);
    if (!hasComment(it.seq) && pad(level).length + flat.length <= WIDTH) return flat;
    return `(\n${pad(level + 1)}${renderSeq(it.seq, level + 1)}\n${pad(level)})`;
  }
  if (it.t === "brace") {
    const flat = inlineItem(it);
    if (!it.elems.some(hasComment) && pad(level).length + flat.length <= WIDTH) return flat;
    return `{\n${it.elems.map((a) => pad(level + 1) + renderSeq(a, level + 1)).join(",\n")}\n${pad(level)}}`;
  }
  return inlineItem(it);
}

/** VAR a = x VAR b = y RETURN z: one line per variable, the result indented under RETURN. */
function renderVars(items: Item[], level: number): string {
  const isKw = (i: Item | undefined, kw: string) => i?.t === "atom" && i.kind === "id" && i.s.toUpperCase() === kw;
  const lines: string[] = [];
  let i = 0;
  while (isKw(items[i], "VAR")) {
    const eq = items.findIndex((x, j) => j > i && x.t === "atom" && x.s === "=");
    if (eq < 0) throw new Error("A VAR needs = and an expression.");
    let end = eq + 1;
    while (end < items.length && !isKw(items[end], "VAR") && !isKw(items[end], "RETURN")) end++;
    const head = `VAR ${inlineSeq(items.slice(i + 1, eq))} = `;
    lines.push(pad(level) + head + renderSeq(items.slice(eq + 1, end), level, head.length));
    i = end;
  }
  if (isKw(items[i], "RETURN")) lines.push(pad(level) + "RETURN\n" + pad(level + 1) + renderSeq(items.slice(i + 1), level + 1));
  else if (i < items.length) lines.push(pad(level) + renderSeq(items.slice(i), level));
  return lines.join("\n").replace(new RegExp(`^${pad(level)}`), "");
}

const STATEMENT = /^(DEFINE|MEASURE|COLUMN|TABLE|FUNCTION|EVALUATE)$/i;

/** Formats a DAX expression or a whole query. Throws with a message when the brackets do not match. */
export function formatDax(text: string): string {
  const tokens = tokenize(text);
  if (tokens.length === 0) return "";
  const items = parse(tokens);
  const isStmt = (i: Item | undefined) => i?.t === "atom" && i.kind === "id" && STATEMENT.test(i.s);
  const isOrder = (i: Item | undefined, next?: Item) => i?.t === "atom" && /^ORDER$/i.test(i.s) && next?.t === "atom" && /^BY$/i.test(next.s);
  const isStart = (i: Item | undefined, next?: Item) => i?.t === "atom" && /^START$/i.test(i.s) && next?.t === "atom" && /^AT$/i.test(next.s);
  if (!items.some((i, j) => isStmt(i) || isOrder(i, items[j + 1]))) return renderSeq(items, 0);

  const out: string[] = [];
  let i = 0;
  const bodyEnd = (from: number) => {
    let e = from;
    while (e < items.length && !isStmt(items[e]) && !isOrder(items[e], items[e + 1]) && !isStart(items[e], items[e + 1])) e++;
    return e;
  };
  let inDefine = false;
  while (i < items.length) {
    const it = items[i];
    if (it.t === "comment") {
      out.push((inDefine ? INDENT : "") + it.s);
      i++;
    } else if (it.t === "atom" && /^DEFINE$/i.test(it.s)) {
      out.push("DEFINE");
      inDefine = true;
      i++;
    } else if (it.t === "atom" && /^(MEASURE|COLUMN|TABLE|FUNCTION)$/i.test(it.s)) {
      const eq = items.findIndex((x, j) => j > i && x.t === "atom" && x.s === "=");
      if (eq < 0) throw new Error(`${it.s.toUpperCase()} needs = and an expression.`);
      const end = bodyEnd(eq + 1);
      out.push(`${INDENT}${it.s.toUpperCase()} ${inlineSeq(items.slice(i + 1, eq))} =\n${pad(2)}${renderSeq(items.slice(eq + 1, end), 2)}`);
      i = end;
    } else if (it.t === "atom" && /^EVALUATE$/i.test(it.s)) {
      inDefine = false;
      const end = bodyEnd(i + 1);
      out.push(`EVALUATE\n${INDENT}${renderSeq(items.slice(i + 1, end), 1)}`);
      i = end;
    } else if (isOrder(it, items[i + 1])) {
      const end = bodyEnd(i + 2);
      const parts: Item[][] = [[]];
      for (const x of items.slice(i + 2, end)) {
        if (x.t === "atom" && x.s === ",") parts.push([]);
        else parts[parts.length - 1].push(x);
      }
      out.push(`ORDER BY\n${parts.map((p) => INDENT + renderSeq(p, 1)).join(",\n")}`);
      i = end;
    } else if (isStart(it, items[i + 1])) {
      const end = bodyEnd(i + 2);
      out.push(`START AT ${inlineSeq(items.slice(i + 2, end))}`);
      i = end;
    } else {
      out.push(renderSeq(items.slice(i, bodyEnd(i + 1)), 0));
      i = bodyEnd(i + 1);
    }
  }
  return out.join("\n");
}
