//! XML reader (quick-xml, MIT). Elements that repeat under the same parent become tables: the attributes and the
//! simple child elements of each occurrence are its columns (the same idea as Power Query's Xml.Tables).
use super::{clean_names, textinfer, Cell, RawTable};
use crate::error::{EngineError, Result};
use quick_xml::events::Event;
use quick_xml::Reader;

#[derive(Default, Debug)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    children: Vec<Node>,
}

fn err<E: std::fmt::Display>(e: E) -> EngineError {
    EngineError::Source(format!("XML error: {e}"))
}

fn local(name: &str) -> String {
    let s = std::borrow::Cow::Borrowed(name);
    s.rsplit(':').next().unwrap_or(&s).to_string()
}

fn start(e: &quick_xml::events::BytesStart) -> Result<Node> {
    let mut n = Node { name: local(e.name().as_ref()), ..Default::default() };
    for a in e.attributes() {
        let a = a.map_err(err)?;
        let k = a.key.as_ref().to_string();
        if k == "xmlns" || k.starts_with("xmlns:") {
            continue;
        }
        n.attrs.push((local(a.key.as_ref()), a.normalized_value(quick_xml::XmlVersion::Implicit1_0).map_err(err)?.into_owned()));
    }
    Ok(n)
}

fn parse(text: &str) -> Result<Node> {
    let mut r = Reader::from_str(text);
    let mut stack: Vec<Node> = vec![Node::default()];
    loop {
        match r.read_event().map_err(err)? {
            Event::Start(e) => stack.push(start(&e)?),
            Event::Empty(e) => {
                let n = start(&e)?;
                stack.last_mut().unwrap().children.push(n);
            }
            Event::End(_) => {
                let n = stack.pop().ok_or_else(|| err("unbalanced end tag"))?;
                stack.last_mut().ok_or_else(|| err("unbalanced end tag"))?.children.push(n);
            }
            Event::Text(t) => stack.last_mut().unwrap().text.push_str(&t.xml10_content()),
            Event::CData(c) => stack.last_mut().unwrap().text.push_str(&c.into_inner()),
            Event::GeneralRef(g) => {
                let name = g.xml10_content().into_owned();
                let ch = match name.as_str() {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    _ => g.resolve_char_ref().ok().flatten(),
                };
                if let Some(c) = ch {
                    stack.last_mut().unwrap().text.push(c);
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err(err("the document ends inside an element"));
    }
    let root = stack.pop().unwrap();
    root.children.into_iter().next().ok_or_else(|| err("the document has no root element"))
}

fn is_leaf(n: &Node) -> bool {
    n.children.is_empty()
}

/// Every table found: (name, occurrences). An element name that repeats under one parent makes a table; when nothing repeats,
/// the root's children (or the root itself) are the single table.
fn find_tables<'a>(root: &'a Node) -> Vec<(String, Vec<&'a Node>)> {
    let mut found: Vec<(String, Vec<&'a Node>)> = Vec::new();
    fn walk<'a>(n: &'a Node, depth: usize, found: &mut Vec<(String, Vec<&'a Node>)>) {
        let mut order: Vec<&str> = Vec::new();
        for c in &n.children {
            if !order.contains(&c.name.as_str()) {
                order.push(&c.name);
            }
        }
        for name in order {
            let group: Vec<&Node> = n.children.iter().filter(|c| c.name == name).collect();
            let simple_leaf = depth > 0 && group.iter().all(|g| g.children.is_empty() && g.attrs.is_empty());
            if group.len() > 1 && !simple_leaf && group.iter().any(|g| !g.attrs.is_empty() || !g.children.is_empty() || !g.text.trim().is_empty()) {
                match found.iter_mut().find(|(t, _)| t == name) {
                    Some((_, v)) => v.extend(group.iter().copied()),
                    None => found.push((name.to_string(), group.clone())),
                }
            }
        }
        for c in &n.children {
            walk(c, depth + 1, found);
        }
    }
    walk(root, 0, &mut found);
    if found.is_empty() {
        let kids: Vec<&Node> = root.children.iter().collect();
        if kids.is_empty() {
            found.push((root.name.clone(), vec![root]));
        } else {
            found.push((root.name.clone(), kids));
        }
    }
    found
}

pub fn tables_of(text: &str) -> Result<Vec<String>> {
    let root = parse(text)?;
    Ok(find_tables(&root).into_iter().map(|(n, _)| n).collect())
}

fn row_fields(n: &Node) -> Vec<(String, String)> {
    let mut f: Vec<(String, String)> = n.attrs.clone();
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for c in n.children.iter().filter(|c| is_leaf(c)) {
        let k = counts.entry(c.name.as_str()).or_insert(0);
        let name = if *k == 0 { c.name.clone() } else { format!("{}.{}", c.name, k) };
        *k += 1;
        f.push((name, c.text.trim().to_string()));
        for (a, v) in &c.attrs {
            f.push((format!("{}.{}", c.name, a), v.clone()));
        }
    }
    if is_leaf(n) && !n.text.trim().is_empty() {
        f.push(("Text".into(), n.text.trim().to_string()));
    }
    f
}

pub fn read(text: &str, table: Option<&str>) -> Result<RawTable> {
    let root = parse(text)?;
    let tables = find_tables(&root);
    let (_, rows) = match table.filter(|t| !t.is_empty()) {
        Some(t) => tables.into_iter().find(|(n, _)| n == t).ok_or_else(|| EngineError::Source(format!("XML error: no table named \"{t}\" in the document")))?,
        None => tables.into_iter().next().unwrap(),
    };
    let fields: Vec<Vec<(String, String)>> = rows.iter().map(|n| row_fields(n)).collect();
    let mut cols: Vec<String> = Vec::new();
    for r in &fields {
        for (k, _) in r {
            if !cols.contains(k) {
                cols.push(k.clone());
            }
        }
    }
    let data = fields
        .iter()
        .map(|r| cols.iter().map(|c| r.iter().find(|(k, _)| k == c).map_or(Cell::Null, |(_, v)| Cell::Text(v.clone()))).collect())
        .collect();
    Ok(textinfer::infer(RawTable { columns: clean_names(cols), rows: data }))
}

#[cfg(test)]
mod tests {
    use super::*;
    const DOC: &str = r#"<?xml version="1.0"?><shop xmlns="urn:x"><name>Main &amp; Co</name>
      <item id="1" kind="a"><title>Pen</title><price>1.5</price></item>
      <item id="2"><title><![CDATA[Ink <b>]]></title><price>2</price><tag>x</tag><tag>y</tag></item>
      <person><n>Ann</n></person><person><n>Bob</n></person><empty/></shop>"#;

    #[test]
    fn repeating_elements_become_tables_with_attributes_and_simple_children_as_columns() {
        assert_eq!(tables_of(DOC).unwrap(), vec!["item", "person"]);
        let t = read(DOC, Some("item")).unwrap();
        assert_eq!(t.columns, vec!["id", "kind", "title", "price", "tag", "tag.1"]);
        assert_eq!(t.rows[0][0], Cell::Int(1));
        assert_eq!(t.rows[0][3], Cell::Float(1.5));
        assert_eq!(t.rows[1][2], Cell::Text("Ink <b>".into()));
        assert_eq!(t.rows[0][1], Cell::Text("a".into()));
        assert_eq!(t.rows[1][1], Cell::Null);
        assert_eq!(read(DOC, Some("person")).unwrap().rows.len(), 2);
        assert_eq!(read(DOC, None).unwrap().rows.len(), 2); // the first table
        assert!(read(DOC, Some("nope")).is_err());
    }

    #[test]
    fn a_document_without_repeats_is_one_table_of_the_root_children_and_bad_xml_is_reported() {
        let t = read("<cfg><a>1</a><b>x</b></cfg>", None).unwrap();
        assert_eq!(tables_of("<cfg><a>1</a><b>x</b></cfg>").unwrap(), vec!["cfg"]);
        assert_eq!(t.columns, vec!["Text"]);
        assert!(read("<a><b></a>", None).is_err());
        assert!(read("", None).is_err());
    }
}
