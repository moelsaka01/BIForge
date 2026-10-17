//! Tables in PDF files (lopdf, MIT). Best effort: the text drawing operators of every page are replayed to get each text
//! run with its position, runs on one baseline form a line, and consecutive lines with at least two runs form a table whose
//! columns are the distinct start positions. Works for PDFs whose text uses simple (single byte) encodings; scanned pages and
//! subset fonts with custom encodings give no or garbled text, and tables without a regular layout are not found.
use super::{clean_names, textinfer, Cell, RawTable};
use crate::error::{EngineError, Result};
use lopdf::content::Operation;
use lopdf::{Document, Object};

#[derive(Debug, Clone)]
struct Run {
    x: f64,
    y: f64,
    text: String,
}

fn num(o: &Object) -> f64 {
    match o {
        Object::Integer(i) => *i as f64,
        Object::Real(r) => *r as f64,
        _ => 0.0,
    }
}

fn decode(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let u: Vec<u16> = bytes[2..].chunks(2).filter(|c| c.len() == 2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u);
    }
    bytes.iter().map(|&b| if b >= 0x20 { char::from_u32(b as u32).unwrap_or(' ') } else { ' ' }).collect()
}

/// Replays the text operators of one page into positioned runs.
fn runs_of(ops: &[Operation]) -> Vec<Run> {
    let (mut tm, mut tlm) = ((0.0f64, 0.0f64), (0.0f64, 0.0f64));
    let mut leading = 0.0f64;
    let mut out = Vec::new();
    for op in ops {
        let a = &op.operands;
        match op.operator.as_str() {
            "BT" => {
                tm = (0.0, 0.0);
                tlm = tm;
            }
            "Tm" if a.len() == 6 => {
                tm = (num(&a[4]), num(&a[5]));
                tlm = tm;
            }
            "Td" if a.len() == 2 => {
                tlm = (tlm.0 + num(&a[0]), tlm.1 + num(&a[1]));
                tm = tlm;
            }
            "TD" if a.len() == 2 => {
                leading = -num(&a[1]);
                tlm = (tlm.0 + num(&a[0]), tlm.1 + num(&a[1]));
                tm = tlm;
            }
            "TL" if a.len() == 1 => leading = num(&a[0]),
            "T*" => {
                tlm = (tlm.0, tlm.1 - leading);
                tm = tlm;
            }
            "Tj" | "'" | "\"" => {
                if op.operator != "Tj" {
                    tlm = (tlm.0, tlm.1 - leading);
                    tm = tlm;
                }
                if let Some(Object::String(b, _)) = a.last() {
                    out.push(Run { x: tm.0, y: tm.1, text: decode(b) });
                }
            }
            "TJ" => {
                if let Some(Object::Array(parts)) = a.first() {
                    let mut text = String::new();
                    for p in parts {
                        match p {
                            Object::String(b, _) => text.push_str(&decode(b)),
                            n if num(n) < -250.0 => text.push('\u{1}'), // a wide gap: a new cell
                            _ => {}
                        }
                    }
                    for (i, piece) in text.split('\u{1}').enumerate() {
                        if !piece.trim().is_empty() {
                            out.push(Run { x: tm.0 + i as f64 * 0.001, y: tm.1, text: piece.to_string() });
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Lines of runs, top to bottom, left to right.
fn lines(mut runs: Vec<Run>) -> Vec<Vec<Run>> {
    runs.retain(|r| !r.text.trim().is_empty());
    runs.sort_by(|a, b| b.y.partial_cmp(&a.y).unwrap().then(a.x.partial_cmp(&b.x).unwrap()));
    let mut out: Vec<Vec<Run>> = Vec::new();
    for r in runs {
        match out.last_mut() {
            Some(l) if (l[0].y - r.y).abs() < 2.0 => l.push(r),
            _ => out.push(vec![r]),
        }
    }
    for l in out.iter_mut() {
        l.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    }
    out
}

fn block_to_table(block: &[Vec<Run>]) -> RawTable {
    let mut xs: Vec<f64> = Vec::new();
    for l in block {
        for r in l {
            if !xs.iter().any(|x| (x - r.x).abs() < 3.0) {
                xs.push(r.x);
            }
        }
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let col = |x: f64| xs.iter().position(|c| (c - x).abs() < 3.0).unwrap_or(0);
    let mut rows: Vec<Vec<Cell>> = block
        .iter()
        .map(|l| {
            let mut row = vec![Cell::Null; xs.len()];
            for r in l {
                let c = col(r.x);
                row[c] = Cell::Text(match &row[c] {
                    Cell::Text(t) => format!("{t} {}", r.text.trim()),
                    _ => r.text.trim().to_string(),
                });
            }
            row
        })
        .collect();
    let header = rows.remove(0);
    let names = header.iter().map(|c| if let Cell::Text(t) = c { t.clone() } else { String::new() }).collect();
    textinfer::infer(RawTable { columns: clean_names(names), rows })
}

/// Every table found: ("Table001 (Page 1)", table).
pub fn tables(path: &str) -> Result<Vec<(String, RawTable)>> {
    let doc = Document::load(path).map_err(|e| EngineError::Source(format!("PDF error: {e}")))?;
    if doc.is_encrypted() {
        return Err(EngineError::Source("PDF error: the file is password protected".into()));
    }
    let mut out = Vec::new();
    for (no, id) in doc.get_pages() {
        let Ok(content) = doc.get_and_decode_page_content(id) else { continue };
        let ls = lines(runs_of(&content.operations));
        let mut block: Vec<Vec<Run>> = Vec::new();
        let flush = |block: &mut Vec<Vec<Run>>, out: &mut Vec<(String, RawTable)>| {
            if block.len() >= 2 {
                let n = out.len() + 1;
                out.push((format!("Table{n:03} (Page {no})"), block_to_table(block)));
            }
            block.clear();
        };
        let mut last_y: Option<f64> = None;
        let gap_limit = {
            let mut d: Vec<f64> = ls.windows(2).map(|w| w[0][0].y - w[1][0].y).collect();
            d.sort_by(|a, b| a.partial_cmp(b).unwrap());
            d.get(d.len() / 2).copied().unwrap_or(14.0) * 2.5
        };
        for l in ls {
            let tabular = l.len() >= 2;
            let far = last_y.is_some_and(|y| y - l[0].y > gap_limit);
            if !tabular || far {
                flush(&mut block, &mut out);
            }
            if tabular {
                block.push(l.clone());
            }
            last_y = Some(l[0].y);
        }
        flush(&mut block, &mut out);
    }
    Ok(out)
}

pub fn choices(path: &str) -> Result<Vec<String>> {
    Ok(tables(path)?.into_iter().map(|(n, _)| n).collect())
}

pub fn read(path: &str, table: Option<&str>) -> Result<RawTable> {
    let all = tables(path)?;
    if all.is_empty() {
        return Err(EngineError::Source("PDF error: no table was found (scanned pages and unusual text encodings are not supported)".into()));
    }
    match table.filter(|t| !t.is_empty()) {
        Some(t) => all.into_iter().find(|(n, _)| n == t).map(|(_, r)| r).ok_or_else(|| EngineError::Source(format!("PDF error: no table named \"{t}\""))),
        None => Ok(all.into_iter().next().unwrap().1),
    }
}

/// Builds small PDFs for tests (also used by the integration tests).
#[doc(hidden)]
pub mod testpdf {
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Document, Object, Stream};

    /// A one-page PDF whose text is drawn at the given (x, y, text) positions with the standard Helvetica font.
    pub fn make(path: &std::path::Path, items: &[(i32, i32, &str)]) {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" });
        let res = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
        let mut ops = vec![Operation::new("BT", vec![]), Operation::new("Tf", vec!["F1".into(), 10.into()])];
        let (mut cx, mut cy) = (0, 0);
        for (x, y, t) in items {
            ops.push(Operation::new("Td", vec![(*x - cx).into(), (*y - cy).into()]));
            ops.push(Operation::new("Tj", vec![Object::string_literal(*t)]));
            (cx, cy) = (*x, *y);
        }
        ops.push(Operation::new("ET", vec![]));
        let content = doc.add_object(Stream::new(dictionary! {}, Content { operations: ops }.encode().unwrap()));
        let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages, "Contents" => content, "Resources" => res, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()] });
        doc.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        doc.save(path).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grid_of_text_becomes_a_table_and_a_paragraph_does_not() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("t.pdf");
        testpdf::make(
            &f,
            &[
                (50, 700, "A long introduction line that is plain text"),
                (50, 650, "Region"), (200, 650, "Units"), (300, 650, "Price"),
                (50, 636, "North"), (200, 636, "10"), (300, 636, "1.5"),
                (50, 622, "South"), (200, 622, "12"), (300, 622, "2"),
                (50, 500, "Closing remark"),
                (50, 300, "k"), (150, 300, "v"),
                (50, 286, "a"), (150, 286, "b"),
            ],
        );
        let p = f.to_str().unwrap();
        assert_eq!(choices(p).unwrap(), vec!["Table001 (Page 1)", "Table002 (Page 1)"]);
        let t = read(p, None).unwrap();
        assert_eq!(t.columns, vec!["Region", "Units", "Price"]);
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[0], vec![Cell::Text("North".into()), Cell::Int(10), Cell::Float(1.5)]);
        let t2 = read(p, Some("Table002 (Page 1)")).unwrap();
        assert_eq!(t2.columns, vec!["k", "v"]);
        assert!(read(p, Some("Table009")).is_err());
    }

    #[test]
    fn a_file_that_is_not_a_pdf_or_has_no_table_is_reported() {
        let d = tempfile::tempdir().unwrap();
        let bad = d.path().join("b.pdf");
        std::fs::write(&bad, "not a pdf").unwrap();
        assert!(read(bad.to_str().unwrap(), None).is_err());
        let f = d.path().join("p.pdf");
        testpdf::make(&f, &[(50, 700, "just a sentence")]);
        assert!(read(f.to_str().unwrap(), None).unwrap_err().to_string().contains("no table"));
    }
}
