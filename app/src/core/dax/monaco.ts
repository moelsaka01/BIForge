// Monaco wiring for DAX: language registration (tokenizer, brackets, completions, signature help, hover) and the
// editor factory. Monaco is loaded on first use, so the rest of the app (and the unit tests) never pull it in.
// Everything that is logic lives in language.ts; this file only adapts it to Monaco's API.

import type * as Monaco from "monaco-editor";
import type { EditorFactory, EditorHandle, EditorInit } from "./editorTypes";
import { completionsAt, consumeAfterCursor, LANGUAGE_ID, monarchLanguage, signatureHelpAt, toMarkerSpecs, type CompletionKind, type DaxContext, type MarkerSpec } from "./language";

let loading: Promise<typeof Monaco> | null = null;

/** Context getters by editor model URI; the providers are registered once and look the context up per model. */
const contexts = new Map<string, () => DaxContext>();

const KIND: Record<CompletionKind, keyof typeof Monaco.languages.CompletionItemKind> = {
  function: "Function",
  keyword: "Keyword",
  table: "Class",
  column: "Field",
  measure: "Variable",
  constant: "Constant",
};

function register(monaco: typeof Monaco): void {
  monaco.languages.register({ id: LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, monarchLanguage as unknown as Monaco.languages.IMonarchLanguage);
  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
      ["(", ")"],
      ["{", "}"],
      ["[", "]"],
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "[", close: "]" },
    ],
  });
  monaco.editor.defineTheme("biforge-dax", {
    base: "vs",
    inherit: true,
    colors: {},
    rules: [
      { token: "keyword", foreground: "0000FF", fontStyle: "bold" },
      { token: "predefined", foreground: "795E26" },
      { token: "constant", foreground: "0070C1" },
      { token: "type", foreground: "267F99" },
      { token: "variable", foreground: "001080" },
      { token: "string", foreground: "A31515" },
      { token: "number", foreground: "098658" },
      { token: "comment", foreground: "6A9955" },
    ],
  });

  const contextOf = (model: Monaco.editor.ITextModel) => contexts.get(model.uri.toString())?.();

  monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    triggerCharacters: ["[", "'", "("],
    provideCompletionItems(model, position) {
      const ctx = contextOf(model);
      if (!ctx) return { suggestions: [] };
      const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const { items, replaceLength } = completionsAt(before, ctx);
      const next = model.getLineContent(position.lineNumber)[position.column - 1];
      const rangeFor = (insertText: string) => ({
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - replaceLength,
        endColumn: position.column + consumeAfterCursor(insertText, next),
      });
      return {
        suggestions: items.map((i) => ({
          label: i.label,
          kind: monaco.languages.CompletionItemKind[KIND[i.kind]],
          insertText: i.insertText,
          detail: i.detail,
          documentation: i.documentation,
          sortText: i.sortText,
          range: rangeFor(i.insertText),
        })),
      };
    },
  });

  monaco.languages.registerSignatureHelpProvider(LANGUAGE_ID, {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp(model, position) {
      const ctx = contextOf(model);
      if (!ctx) return null;
      const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const s = signatureHelpAt(before, ctx.catalog);
      if (!s) return null;
      return {
        value: {
          signatures: [{ label: s.label, documentation: s.documentation + (s.implemented ? "" : "\n\nNot implemented in BIForge yet."), parameters: s.parameters.map((p) => ({ label: p })) }],
          activeSignature: 0,
          activeParameter: s.activeParameter,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerHoverProvider(LANGUAGE_ID, {
    provideHover(model, position) {
      const ctx = contextOf(model);
      const word = model.getWordAtPosition(position);
      if (!ctx || !word) return null;
      // include dots (STDEV.S): extend the word over the surrounding identifier characters
      const line = model.getLineContent(position.lineNumber);
      let s = word.startColumn - 1;
      let e = word.endColumn - 1;
      while (s > 0 && /[A-Za-z0-9_.]/.test(line[s - 1])) s--;
      while (e < line.length && /[A-Za-z0-9_.]/.test(line[e])) e++;
      const name = line.slice(s, e);
      const f = ctx.catalog.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!f) return null;
      return {
        range: { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: s + 1, endColumn: e + 1 },
        contents: [{ value: "`" + f.signature + "`" }, { value: f.description + (f.implemented ? "" : "\n\n*Not implemented in BIForge yet.*") }],
      };
    },
  });
}

export function loadMonaco(): Promise<typeof Monaco> {
  loading ??= (async () => {
    const [monaco, worker] = await Promise.all([import("monaco-editor"), import("monaco-editor/editor/editor.worker?worker")]);
    (self as unknown as { MonacoEnvironment: Monaco.Environment }).MonacoEnvironment = { getWorker: () => new worker.default() };
    register(monaco);
    return monaco;
  })();
  return loading;
}

/** The editor factory used by the app. */
export const createMonacoEditor: EditorFactory = async (container: HTMLElement, init: EditorInit): Promise<EditorHandle> => {
  const monaco = await loadMonaco();
  const model = monaco.editor.createModel(init.value, LANGUAGE_ID);
  const key = model.uri.toString();
  contexts.set(key, init.getContext);
  const editor = monaco.editor.create(container, {
    model,
    theme: "biforge-dax",
    ariaLabel: init.ariaLabel,
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    wordWrap: "on",
    fontSize: 14,
    tabSize: 4,
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    parameterHints: { enabled: true },
    fixedOverflowWidgets: true,
  });
  let applying = false;
  const sub = model.onDidChangeContent(() => {
    if (!applying) init.onChange(model.getValue());
  });
  return {
    getValue: () => model.getValue(),
    setValue(value) {
      if (model.getValue() === value) return;
      applying = true;
      model.setValue(value);
      applying = false;
    },
    setMarkers(markers: MarkerSpec[]) {
      const len = model.getValueLength();
      const specs = toMarkerSpecs(
        markers.map((m) => ({ severity: m.severity, code: "", message: m.message, start: m.start, end: m.end })),
        len,
      );
      monaco.editor.setModelMarkers(
        model,
        "biforge-dax",
        specs.map((m) => {
          const a = model.getPositionAt(m.start);
          const b = model.getPositionAt(m.end);
          return {
            severity: m.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
            message: m.message,
            startLineNumber: a.lineNumber,
            startColumn: a.column,
            endLineNumber: b.lineNumber,
            endColumn: b.column,
          };
        }),
      );
    },
    focus: () => editor.focus(),
    getSelection: () => {
      const s = editor.getSelection();
      return s && !s.isEmpty() ? model.getValueInRange(s) : "";
    },
    dispose() {
      sub.dispose();
      contexts.delete(key);
      editor.dispose();
      model.dispose();
    },
  };
};
