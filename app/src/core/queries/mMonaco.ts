// Monaco wiring for M: language registration (tokenizer, brackets, completions) and the editor factory.
// Monaco is loaded on first use (shared with the DAX editor).
import type * as Monaco from "monaco-editor";
import type { EditorFactory, EditorHandle, EditorInit } from "../dax/editorTypes";
import { loadMonaco } from "../dax/monaco";
import { completionsAt, M_LANGUAGE_ID, monarchLanguage, type MContext } from "./mLanguage";
import { toMarkerSpecs, type MarkerSpec } from "../dax/language";

const contexts = new Map<string, () => MContext>();
let registered = false;

const KIND: Record<string, keyof typeof Monaco.languages.CompletionItemKind> = {
  function: "Function",
  keyword: "Keyword",
  column: "Field",
  query: "Class",
  step: "Variable",
  constant: "Constant",
};

function register(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: M_LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(M_LANGUAGE_ID, monarchLanguage as unknown as Monaco.languages.IMonarchLanguage);
  monaco.languages.setLanguageConfiguration(M_LANGUAGE_ID, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["(", ")"], ["{", "}"], ["[", "]"]],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string"] },
    ],
  });
  monaco.languages.registerCompletionItemProvider(M_LANGUAGE_ID, {
    triggerCharacters: ["[", "."],
    provideCompletionItems(model, position) {
      const ctx = contexts.get(model.uri.toString())?.();
      if (!ctx) return { suggestions: [] };
      const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const { items, replaceLength } = completionsAt(before, ctx);
      return {
        suggestions: items.map((i) => ({
          label: i.label,
          kind: monaco.languages.CompletionItemKind[KIND[i.kind] ?? "Text"],
          insertText: i.insertText,
          detail: i.detail,
          range: {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: position.column - replaceLength,
            endColumn: position.column,
          },
        })),
      };
    },
  });
}

/** Editor factory for M text. `init.getContext` must return an `MContext` (typed loosely to share the DAX editor component). */
export const createMMonacoEditor: EditorFactory = async (container: HTMLElement, init: EditorInit): Promise<EditorHandle> => {
  const monaco = await loadMonaco();
  register(monaco);
  const model = monaco.editor.createModel(init.value, M_LANGUAGE_ID);
  const key = model.uri.toString();
  contexts.set(key, init.getContext as unknown as () => MContext);
  const editor = monaco.editor.create(container, {
    model,
    theme: "biforge-dax",
    ariaLabel: init.ariaLabel,
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    wordWrap: "off",
    fontSize: 14,
    tabSize: 4,
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
      const specs = toMarkerSpecs(markers.map((m) => ({ severity: m.severity, code: "", message: m.message, start: m.start, end: m.end })), model.getValueLength());
      monaco.editor.setModelMarkers(
        model,
        "biforge-m",
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
    dispose() {
      sub.dispose();
      contexts.delete(key);
      editor.dispose();
      model.dispose();
    },
  };
};
