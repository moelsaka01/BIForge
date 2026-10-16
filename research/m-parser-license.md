# M parser: license check and decision

Checked 2026-10-16 with the GitHub API (not from memory).

| Repository | License | Language | Notes |
|---|---|---|---|
| microsoft/powerquery-parser | MIT (LICENSE file, `package.json` says MIT; npm `@microsoft/powerquery-parser` 4.0.0) | TypeScript, Node >= 22 | Lexer + parser + AST for M. Active (commit 2026-10-15). |
| microsoft/powerquery-language-services | MIT | TypeScript | Not used. |
| microsoft/powerquery-formatter | MIT | TypeScript | Not used. |

**Compatibility:** MIT is compatible with BIForge's Apache-2.0 license. Reuse would require keeping the MIT notice (NOTICE entry) for any copied or bundled code.

**Decision (recorded per CLAUDE.md):** the parser is *not* embedded.

1. The evaluator that folds M to DuckDB SQL lives in the Rust core (`crates/m`). A TypeScript parser could only run in the WebView, so the Rust side would still need its own parser, or an embedded JS engine, or a JSON round trip of the AST for every evaluation. All three are worse than one small Rust parser.
2. M's grammar is small and fully described in Microsoft's public language specification. `crates/m` therefore has its own lexer and parser written from the specification, with no code copied from the MIT project.
3. The MIT parser stays a candidate for a *test oracle* (parse the same corpus with both and compare accept/reject). That is not set up yet; see `docs/COVERAGE.md`.

If the decision changes to bundling the TypeScript parser (for example for editor tooling in the WebView), add its MIT text to a `NOTICE` file in the same commit.

## What our parser covers
Everything the Power Query UI generates plus hand-written queries of normal complexity: `let/in`, records, lists, `each`, lambdas (typed or untyped parameters), `if`, `try/otherwise`, `error`, `type` expressions (primitive, nullable, list, record, table), the `is`/`as`/`meta` operators, item and field access (with `?`), quoted identifiers (`#"..."`), `#table/#date/...` intrinsics, comments, text escapes `#(lf)`, `#(0041)`, numbers with exponents and hex. Not covered: `section` documents, function types, implicit projection `[[a],[b]]`. Those report a clear parse error.
