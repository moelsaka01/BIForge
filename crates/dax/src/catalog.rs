//! Function catalog: names, categories, signatures and descriptions, loaded from `catalog/functions.json`
//! (our own wording). The same file feeds editor IntelliSense. Which functions are *implemented* is not
//! stored here; it comes from the evaluator (`eval::functions::is_implemented`).
//!
//! Signature grammar: `NAME(p1, p2?, p3*, p4+, (a, b)+)`: `?` optional, `*` zero or more, `+` one or more,
//! parentheses group parameters that repeat together.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

const CATALOG_JSON: &str = include_str!("../catalog/functions.json");

#[derive(Debug, Deserialize)]
struct RawEntry {
    c: String,
    s: String,
    r: String,
    d: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: String,
    pub optional: bool,
    pub repeating: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub name: String,
    pub category: String,
    pub signature: String,
    pub returns_table: bool,
    pub description: String,
    pub params: Vec<Param>,
    pub min_args: usize,
    /// `None` when the function takes a repeating argument list.
    pub max_args: Option<usize>,
}

pub struct Catalog {
    list: Vec<FunctionInfo>,
    by_name: HashMap<String, usize>,
}

impl Catalog {
    /// The built-in catalog (parsed once).
    pub fn builtin() -> &'static Catalog {
        static C: OnceLock<Catalog> = OnceLock::new();
        C.get_or_init(|| Catalog::from_json(CATALOG_JSON).expect("built-in catalog is valid"))
    }

    pub fn from_json(text: &str) -> Result<Catalog, String> {
        let raw: Vec<RawEntry> = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let mut list = Vec::with_capacity(raw.len());
        let mut by_name = HashMap::new();
        for r in raw {
            let info = parse_signature(&r.s).map(|(name, params, min_args, max_args)| FunctionInfo {
                name,
                category: r.c,
                signature: r.s.clone(),
                returns_table: r.r == "table",
                description: r.d,
                params,
                min_args,
                max_args,
            })?;
            if by_name.insert(info.name.to_ascii_uppercase(), list.len()).is_some() {
                return Err(format!("duplicate function {}", info.name));
            }
            list.push(info);
        }
        Ok(Catalog { list, by_name })
    }

    pub fn get(&self, name: &str) -> Option<&FunctionInfo> {
        self.by_name.get(&name.to_ascii_uppercase()).map(|&i| &self.list[i])
    }

    pub fn all(&self) -> &[FunctionInfo] {
        &self.list
    }
}

/// Returns (name, flattened params, min args, max args).
fn parse_signature(sig: &str) -> Result<(String, Vec<Param>, usize, Option<usize>), String> {
    let open = sig.find('(').ok_or_else(|| format!("bad signature {sig}"))?;
    let name = sig[..open].trim().to_string();
    let inner = sig[open + 1..].strip_suffix(')').ok_or_else(|| format!("bad signature {sig}"))?;
    let mut params = Vec::new();
    let mut min = 0usize;
    let mut max = Some(0usize);
    for item in split_top(inner) {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let (body, suffix) = match item.chars().last() {
            Some(c @ ('?' | '*' | '+')) => (&item[..item.len() - 1], Some(c)),
            _ => (item, None),
        };
        let names: Vec<String> = match body.strip_prefix('(').and_then(|b| b.strip_suffix(')')) {
            Some(group) => split_top(group).into_iter().map(|g| g.trim().trim_end_matches('?').to_string()).collect(),
            None => vec![body.to_string()],
        };
        // inside a group, a trailing '?' marks that member optional (e.g. (orderBy, order?)*)
        let group_required = match body.strip_prefix('(').and_then(|b| b.strip_suffix(')')) {
            Some(group) => split_top(group).iter().filter(|g| !g.trim().ends_with('?')).count(),
            None => 1,
        };
        let width = names.len();
        let optional = matches!(suffix, Some('?') | Some('*'));
        let repeating = matches!(suffix, Some('*') | Some('+'));
        match suffix {
            None => {
                min += width;
                max = max.map(|m| m + width);
            }
            Some('?') => max = max.map(|m| m + width),
            Some('+') => {
                min += group_required;
                max = None;
            }
            _ => max = None,
        }
        for n in names {
            params.push(Param { name: n, optional, repeating });
        }
    }
    Ok((name, params, min, max))
}

fn split_top(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut cur = String::new();
    for ch in s.chars() {
        match ch {
            '(' => {
                depth += 1;
                cur.push(ch);
            }
            ')' => {
                depth -= 1;
                cur.push(ch);
            }
            ',' if depth == 0 => out.push(std::mem::take(&mut cur)),
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_catalog_loads_and_is_case_insensitive() {
        let c = Catalog::builtin();
        assert!(c.all().len() > 300);
        let f = c.get("calculate").unwrap();
        assert_eq!(f.name, "CALCULATE");
        assert_eq!((f.min_args, f.max_args), (1, None));
        assert!(c.get("NOPE").is_none());
    }

    #[test]
    fn signature_arity() {
        let c = Catalog::builtin();
        let ar = |n: &str| {
            let f = c.get(n).unwrap();
            (f.min_args, f.max_args)
        };
        assert_eq!(ar("SUM"), (1, Some(1)));
        assert_eq!(ar("IF"), (2, Some(3)));
        assert_eq!(ar("BLANK"), (0, Some(0)));
        assert_eq!(ar("ADDCOLUMNS"), (3, None));
        assert_eq!(ar("SWITCH"), (3, None));
        assert_eq!(ar("COUNTROWS"), (0, Some(1)));
        assert_eq!(ar("TOPN"), (2, None));
        assert_eq!(ar("DIVIDE"), (2, Some(3)));
        assert_eq!(ar("ROW"), (2, None));
        assert!(c.get("SUMX").unwrap().params.iter().all(|p| !p.optional));
    }
}
