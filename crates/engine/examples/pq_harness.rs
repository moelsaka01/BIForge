//! Development harness for the Power Query editor: serves the real M engine over HTTP so the React editor can be
//! run and looked at in a browser without the Tauri window.
//!
//!     cargo run -p biforge-engine --example pq_harness [port]      (default 1432)
//!
//! GET  /info          -> {"fixtures": "<dir of the DAX fixture CSVs>"}
//! POST /engine/<fn>   -> the engine functions the session needs (import, tableInfo, drop, open)
//! POST /m/<fn>        -> the same operations as the Tauri commands m_* (see app/src-tauri/src/pq.rs)
//! Not part of the product: it listens on 127.0.0.1 only and exists for manual checks and screenshots.

use biforge_engine::{Engine, MemoryCredentialStore, SourceSpec};
use biforge_m::steps;
use biforge_m::transforms::{apply_transform, folder_combine_query, Transform};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/dax/fixtures")
}

fn respond(mut s: TcpStream, status: &str, body: &str) {
    let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
}

fn queries(v: &Value) -> Result<BTreeMap<String, String>, String> {
    serde_json::from_value(v["queries"].clone()).map_err(|e| e.to_string())
}

fn s(v: &Value, k: &str) -> Result<String, String> {
    v[k].as_str().map(|x| x.to_string()).ok_or_else(|| format!("missing {k}"))
}

fn handle(engine: &Engine, creds: &MemoryCredentialStore, path: &str, v: &Value) -> Result<Value, String> {
    let e = |x: biforge_engine::EngineError| x.to_string();
    Ok(match path {
        "/engine/open" => json!(engine.table_names().map_err(e)?),
        "/engine/import" => {
            let spec: SourceSpec = serde_json::from_value(v["spec"].clone()).map_err(|x| x.to_string())?;
            serde_json::to_value(engine.import(&s(v, "table")?, &spec, creds).map_err(e)?).unwrap()
        }
        "/engine/tableInfo" => {
            let t = s(v, "table")?;
            if engine.has_table(&t).map_err(e)? { serde_json::to_value(engine.table_info(&t).map_err(e)?).unwrap() } else { Value::Null }
        }
        "/engine/drop" => {
            engine.drop_table(&s(v, "table")?).map_err(e)?;
            Value::Null
        }
        "/m/parse" => serde_json::to_value(steps::parse_query(&s(v, "text")?)?).unwrap(),
        "/m/check" => {
            let text = s(v, "text")?;
            match biforge_m::parse(&text) {
                Ok(_) => json!([]),
                Err(x) => {
                    let start = biforge_dax::editor::utf16_offset(&text, x.start);
                    json!([{"start": start, "end": start + 1, "message": x.message}])
                }
            }
        }
        "/m/applyTransform" => {
            let t: Transform = serde_json::from_value(v["transform"].clone()).map_err(|x| x.to_string())?;
            serde_json::to_value(apply_transform(&s(v, "text")?, v["after"].as_str(), &t)?).unwrap()
        }
        "/m/editStep" => {
            let text = s(v, "text")?;
            let ed = &v["edit"];
            let name = |k: &str| ed[k].as_str().unwrap_or("").to_string();
            let out = match ed["op"].as_str().unwrap_or("") {
                "insert" => steps::insert_step(&text, ed["after"].as_str(), &name("name"), &name("expr"))?,
                "delete" => steps::delete_step(&text, &name("name"))?,
                "deleteFrom" => steps::delete_from(&text, &name("name"))?,
                "rename" => steps::rename_step(&text, &name("old"), &name("new"))?,
                "setExpr" => steps::set_step_expr(&text, &name("name"), &name("expr"))?,
                "move" => steps::move_step(&text, &name("name"), ed["delta"].as_i64().unwrap_or(0) as i32)?,
                "renameRef" => steps::rename_references(&text, &name("old"), &name("new")),
                other => return Err(format!("unknown edit {other}")),
            };
            json!(out)
        }
        "/m/dependencies" => {
            let q = queries(v)?;
            json!(q.keys().map(|k| (k.clone(), biforge_m::run::dependencies(&q, k))).collect::<BTreeMap<_, _>>())
        }
        "/m/folderQuery" => json!(folder_combine_query(&s(v, "folder")?, &s(v, "extension")?, &s(v, "delimiter")?)),
        "/m/analyze" => serde_json::to_value(engine.m_analyze(&queries(v)?, &s(v, "query")?).map_err(e)?).unwrap(),
        "/m/preview" => serde_json::to_value(engine.m_preview(&queries(v)?, &s(v, "query")?, v["step"].as_str(), v["limit"].as_u64().unwrap_or(1000) as usize).map_err(e)?).unwrap(),
        "/m/load" => serde_json::to_value(engine.m_load(&queries(v)?, &s(v, "query")?, &s(v, "table")?).map_err(e)?).unwrap(),
        "/m/queryKinds" => {
            let q = queries(v)?;
            json!(q.keys().map(|k| (k.clone(), engine.m_query_kind(&q, k))).collect::<BTreeMap<_, _>>())
        }
        other => return Err(format!("unknown endpoint {other}")),
    })
}

fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(1432);
    let engine = Engine::in_memory().expect("in-memory store");
    let creds = MemoryCredentialStore::default();
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    println!("Power Query harness listening on http://127.0.0.1:{port}");
    for stream in listener.incoming().flatten() {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            continue;
        }
        let mut len = 0usize;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                break;
            }
            if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0u8; len];
        let _ = reader.read_exact(&mut body);
        let (method, path) = {
            let mut it = line.split_whitespace();
            (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_string())
        };
        match (method.as_str(), path.as_str()) {
            ("OPTIONS", _) => respond(stream, "204 No Content", ""),
            ("GET", "/info") => respond(stream, "200 OK", &json!({"fixtures": fixtures().canonicalize().unwrap().to_string_lossy().replace("\\\\?\\", "").replace('\\', "/")}).to_string()),
            ("POST", p) => {
                let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                match handle(&engine, &creds, p, &v) {
                    Ok(out) => respond(stream, "200 OK", &out.to_string()),
                    Err(err) => respond(stream, "400 Bad Request", &json!({"error": err}).to_string()),
                }
            }
            _ => respond(stream, "404 Not Found", "{}"),
        }
    }
}
