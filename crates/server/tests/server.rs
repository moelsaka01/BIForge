//! Two BIForge parties talk to a real server over HTTP on this machine: the host (admin, editor) and guests
//! (viewers) with different identities. The guests must see different rows under row-level security.

use biforge_engine::{MemoryCredentialStore, SourceSpec};
use biforge_publish::backend::*;
use biforge_publish::http::ReqwestHttp;
use biforge_publish::keys::Identity;
use biforge_publish::manifest::{AccessLevel, IncludedTable};
use biforge_publish::package::{self, BuildInput, PackageFile};
use biforge_server::{start, Config, Running};
use serde_json::Value;

const REGION: &str = "table Region\n\tcolumn Id\n\t\tdataType: int64\n\tcolumn Name\n\t\tdataType: string\n\tcolumn Manager\n\t\tdataType: string\n";
const SALES: &str = "table Sales\n\tcolumn Id\n\t\tdataType: int64\n\tcolumn RegionId\n\t\tdataType: int64\n\tcolumn Qty\n\t\tdataType: int64\n\tmeasure Total = SUM(Sales[Qty])\n";
const RELS: &str = "relationship r1\n\tfromColumn: Sales.RegionId\n\ttoColumn: Region.Id\n";

fn package_bytes(version: u64, signer: &Identity, key_note: &str) -> Vec<u8> {
    let tmp = tempfile::tempdir().unwrap();
    let engine = biforge_engine::Engine::in_memory().unwrap();
    let creds = MemoryCredentialStore::default();
    let csv = |name: &str, text: &str| {
        let p = tmp.path().join(name);
        std::fs::write(&p, text).unwrap();
        SourceSpec::Csv { path: p.to_string_lossy().into_owned(), delimiter: None, header: None }
    };
    engine.import("Region", &csv("r.csv", "Id,Name,Manager\n1,East,ann@x.com\n2,West,bob@x.com\n3,North,ann@x.com\n"), &creds).unwrap();
    engine.import("Sales", &csv("s.csv", &format!("Id,RegionId,Qty\n1,1,10\n2,2,20\n3,3,30\n4,9,1000\n")), &creds).unwrap();
    let mut files = vec![
        PackageFile { path: "project/Demo.SemanticModel/definition/tables/Region.tmdl".into(), bytes: REGION.as_bytes().to_vec() },
        PackageFile { path: "project/Demo.SemanticModel/definition/tables/Sales.tmdl".into(), bytes: SALES.as_bytes().to_vec() },
        PackageFile { path: "project/Demo.SemanticModel/definition/relationships.tmdl".into(), bytes: RELS.as_bytes().to_vec() },
        PackageFile { path: "project/Demo.Report/note.txt".into(), bytes: key_note.as_bytes().to_vec() },
    ];
    let mut included = Vec::new();
    for (t, cols) in [("Region", vec!["Id", "Name", "Manager"]), ("Sales", vec!["Id", "RegionId", "Qty"])] {
        let out = tmp.path().join(format!("{t}.parquet"));
        engine.export_parquet(t, &cols.iter().map(|c| c.to_string()).collect::<Vec<_>>(), &out).unwrap();
        let rel = format!("data/{t}.parquet");
        files.push(PackageFile { path: rel.clone(), bytes: std::fs::read(&out).unwrap() });
        included.push(IncludedTable { table: t.into(), columns: cols.iter().map(|c| c.to_string()).collect(), data_file: rel });
    }
    package::build(
        BuildInput {
            package_id: "pkg1".into(),
            version,
            report_name: "Demo".into(),
            publisher_name: "Host".into(),
            access: AccessLevel::Public,
            included,
            permissions: vec![],
            created_at: "2026-10-18T00:00:00Z".into(),
            files,
            recipients: vec![],
        },
        signer,
    )
    .unwrap()
}

fn host(dir: &std::path::Path, token: Option<String>) -> Running {
    start(Config { data_dir: dir.to_path_buf(), bind: "127.0.0.1:0".parse().unwrap(), admin_token: token, public_url: None }).unwrap()
}

fn total(c: &Client, ws: &str) -> Result<String, String> {
    let v: Value = c.query(ws, "sales", "EVALUATE ROW(\"t\", [Total])").map_err(|e| e.to_string())?;
    Ok(v["results"][0]["rows"][0][0]["v"].as_str().unwrap().to_string())
}

fn join(http: &ReqwestHttp, srv: &Running, admin: &Client, ws: &str, role: WsRole, who: &str, rls: &[&str]) -> JoinResponse {
    let inv = admin.invite(ws, &InviteRequest { role, identity: who.into(), rls_roles: rls.iter().map(|s| s.to_string()).collect(), expires_minutes: 60 }).unwrap();
    assert!(inv.link.starts_with("biforge://open?src=server&url="), "{}", inv.link);
    assert!(!inv.link.contains("bfa_"), "the link must not carry the admin token");
    Client::join(http, &srv.url(), &inv.token, who).unwrap()
}

#[test]
fn two_guests_see_different_rows_and_the_server_enforces_roles() {
    let dir = tempfile::tempdir().unwrap();
    let http = ReqwestHttp::new().unwrap();
    let srv = host(dir.path(), None);
    let admin_token = srv.admin_token.clone().expect("first start makes an admin token");
    let admin = Client::new(&http, &srv.url(), &admin_token);

    let ws = admin.create_workspace("Sales team").unwrap().id;
    let ann = join(&http, &srv, &admin, &ws, WsRole::Viewer, "ann@x.com", &["Mine"]);
    let bob = join(&http, &srv, &admin, &ws, WsRole::Viewer, "bob@x.com", &["Mine"]);
    let eve = join(&http, &srv, &admin, &ws, WsRole::Viewer, "eve@x.com", &[]);
    let ed = join(&http, &srv, &admin, &ws, WsRole::Editor, "ed@x.com", &[]);
    let (c_ann, c_bob, c_eve, c_ed) = (Client::new(&http, &srv.url(), &ann.token), Client::new(&http, &srv.url(), &bob.token), Client::new(&http, &srv.url(), &eve.token), Client::new(&http, &srv.url(), &ed.token));

    // the join response carries what the admin set; the guest chose only the display name
    assert_eq!((ann.identity.as_str(), ann.role), ("ann@x.com", WsRole::Viewer));

    // authorization: viewers cannot upload or manage; editors cannot invite; strangers have nothing
    let signer = Identity::generate();
    assert!(c_ann.upload_report(&ws, "sales", package_bytes(1, &signer, "")).unwrap_err().to_string().contains("403"));
    assert!(c_ann.members(&ws).is_err());
    assert!(c_ed.invite(&ws, &InviteRequest { role: WsRole::Viewer, identity: "x".into(), rls_roles: vec![], expires_minutes: 5 }).is_err());
    assert!(Client::new(&http, &srv.url(), "bfm_nope").workspaces().is_err());

    // upload by the editor (signed, public), then the data roles
    let info = c_ed.upload_report(&ws, "sales", package_bytes(1, &signer, "")).unwrap();
    assert_eq!((info.version, info.has_roles), (1, false));
    // without roles every member sees all rows (including the row with no region)
    assert_eq!(total(&c_ann, &ws).unwrap(), "1060");
    c_ed.set_roles(&ws, "sales", &[RlsRole { name: "Mine".into(), filters: vec![RlsFilter { table: "Region".into(), expression: "[Manager] = USERPRINCIPALNAME()".into() }] }]).unwrap();
    assert!(c_ed.set_roles(&ws, "sales", &[RlsRole { name: "Bad".into(), filters: vec![RlsFilter { table: "Region".into(), expression: "[Nope] = 1".into() }] }]).is_err());
    assert!(c_ann.set_roles(&ws, "sales", &[]).is_err());

    // the test of the phase: two users, different rows
    assert_eq!(total(&c_ann, &ws).unwrap(), "40");
    assert_eq!(total(&c_bob, &ws).unwrap(), "20");
    assert!(total(&c_eve, &ws).unwrap_err().contains("No data role"));
    assert_eq!(total(&c_ed, &ws).unwrap(), "1060");
    assert_eq!(total(&admin, &ws).unwrap(), "1060");

    // DAX cannot reach hidden rows, and the table itself is pruned
    let v = c_bob.query(&ws, "sales", "EVALUATE ROW(\"t\", CALCULATE([Total], ALL(Region), REMOVEFILTERS(Sales)), \"n\", COUNTROWS(ALL(Region)))").unwrap();
    assert_eq!(v["results"][0]["rows"][0][0]["v"], "20");
    assert_eq!(v["results"][0]["rows"][0][1]["v"], "1");
    let v = c_ann.query(&ws, "sales", "EVALUATE SELECTCOLUMNS(Region, \"n\", Region[Name]) ORDER BY [n]").unwrap();
    let names: Vec<&str> = v["results"][0]["rows"].as_array().unwrap().iter().map(|r| r[0]["v"].as_str().unwrap()).collect();
    assert_eq!(names, ["East", "North"]);

    // the project files (for viewing) carry no data
    let files = c_ann.project(&ws, "sales").unwrap();
    assert!(files.iter().all(|(p, _)| p.starts_with("project/")) && files.iter().any(|(p, _)| p.ends_with("Sales.tmdl")));

    // a new version from the same publisher is accepted and used; an older one and another publisher are refused
    c_ed.upload_report(&ws, "sales", package_bytes(2, &signer, "v2")).unwrap();
    assert_eq!(c_ed.reports(&ws).unwrap()[0].version, 2);
    assert!(c_ed.upload_report(&ws, "sales", package_bytes(2, &signer, "again")).unwrap_err().to_string().contains("409"));
    assert!(c_ed.upload_report(&ws, "sales", package_bytes(3, &Identity::generate(), "")).is_err());
    assert_eq!(total(&c_bob, &ws).unwrap(), "20");

    // an invitation works once
    let inv = admin.invite(&ws, &InviteRequest { role: WsRole::Viewer, identity: "z@x.com".into(), rls_roles: vec![], expires_minutes: 5 }).unwrap();
    Client::join(&http, &srv.url(), &inv.token, "Z").unwrap();
    assert!(Client::join(&http, &srv.url(), &inv.token, "Z again").unwrap_err().to_string().contains("already used"));
    assert!(Client::join(&http, &srv.url(), "bfi_unknown", "Q").is_err());

    // changing a role takes effect at once; a revoked member is locked out at once
    let members = admin.members(&ws).unwrap();
    let bob_member = members.iter().find(|m| m.id == bob.member_id).unwrap();
    assert_eq!(bob_member.identity, "bob@x.com");
    admin.set_member(&ws, &bob.member_id, None, Some(vec![])).unwrap();
    assert!(total(&c_bob, &ws).unwrap_err().contains("No data role"));
    admin.set_member(&ws, &bob.member_id, None, Some(vec!["Mine".into()])).unwrap();
    assert_eq!(total(&c_bob, &ws).unwrap(), "20");
    admin.revoke(&ws, &bob.member_id).unwrap();
    assert!(total(&c_bob, &ws).unwrap_err().contains("401"));

    // the audit log recorded who did what
    let log = admin.audit(&ws).unwrap();
    let events: Vec<&str> = log.iter().map(|e| e.event.as_str()).collect();
    for e in ["workspace-create", "invite-create", "join", "report-upload", "roles-set", "query", "member-change", "revoke", "refused"] {
        assert!(events.contains(&e), "missing audit event {e}: {events:?}");
    }
    assert!(log.iter().any(|e| e.event == "refused" && e.actor.contains("ann@x.com") || e.actor.contains(&ann.member_id)));
    assert!(c_ann.audit(&ws).is_err());

    // the server remembers everything after a restart (the guests' tokens still work, the admin token is unchanged)
    srv.stop();
    let srv2 = host(dir.path(), None);
    assert!(srv2.admin_token.is_none());
    let c_ann2 = Client::new(&http, &srv2.url(), &ann.token);
    assert_eq!(total(&c_ann2, &ws).unwrap(), "40");
    assert_eq!(Client::new(&http, &srv2.url(), &admin_token).workspaces().unwrap().len(), 1);
    // a guest of another workspace sees nothing of this one
    let ws2 = Client::new(&http, &srv2.url(), &admin_token).create_workspace("Other").unwrap().id;
    assert!(c_ann2.reports(&ws2).is_err());
}

#[test]
fn a_report_id_cannot_reach_another_workspace() {
    use biforge_publish::http::{Http, Request};
    let dir = tempfile::tempdir().unwrap();
    let http = ReqwestHttp::new().unwrap();
    let srv = host(dir.path(), Some("bfa_fixed".into()));
    let admin = Client::new(&http, &srv.url(), "bfa_fixed");
    let a = admin.create_workspace("A").unwrap().id;
    let b = admin.create_workspace("B").unwrap().id;
    let signer = Identity::generate();
    admin.upload_report(&b, "secret", package_bytes(1, &signer, "")).unwrap();
    let in_a = join(&http, &srv, &admin, &a, WsRole::Viewer, "a@x.com", &[]);
    // the member of A tries to read B's report through a report id that climbs out of A's folder
    for rid in [format!("..%2F..%2F{b}%2Freports%2Fsecret"), format!("..%5C..%5C{b}%5Creports%5Csecret"), format!("%2E%2E%2F%2E%2E%2F{b}%2Freports%2Fsecret")] {
        for (method, tail, body) in [("GET", "project", None), ("GET", "roles", None), ("POST", "query", Some(r#"{"query":"EVALUATE ROW(\"t\", 1)"}"#))] {
            let url = format!("{}/api/workspaces/{a}/reports/{rid}/{tail}", srv.url());
            let mut req = Request::new(method, &url).bearer(&in_a.token);
            if let Some(b) = body {
                req = req.bytes("application/json", b.as_bytes().to_vec());
            }
            let r = http.send(&req).unwrap();
            assert!(!r.ok(), "{method} {tail} {rid} must not work: {}", r.describe());
        }
    }
    // and the real one is still reachable by the admin
    assert!(admin.project(&b, "secret").is_ok());
    // an upload with such an id is refused too
    assert!(admin.upload_report(&a, "../x", package_bytes(1, &signer, "")).is_err());
}

#[test]
fn only_the_server_admin_creates_workspaces() {
    let dir = tempfile::tempdir().unwrap();
    let http = ReqwestHttp::new().unwrap();
    let srv = host(dir.path(), Some("bfa_fixed".into()));
    let admin = Client::new(&http, &srv.url(), "bfa_fixed");
    let ws = admin.create_workspace("W").unwrap().id;
    let v = join(&http, &srv, &admin, &ws, WsRole::Viewer, "v@x.com", &[]);
    assert!(Client::new(&http, &srv.url(), &v.token).create_workspace("mine").is_err());
    assert!(Client::new(&http, &srv.url(), "bfa_wrong").create_workspace("mine").is_err());
}
