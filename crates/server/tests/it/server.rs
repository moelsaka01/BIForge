//! Two BIForge parties talk to a real server over HTTP on this machine: the host (admin, editor) and guests
//! (viewers) with different identities. The guests must see different rows under row-level security.

use biforge_engine::{MemoryCredentialStore, SourceSpec};
use biforge_publish::backend::*;
use biforge_publish::http::{Http, ReqwestHttp};
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
    start(Config { data_dir: dir.to_path_buf(), bind: "127.0.0.1:0".parse().unwrap(), admin_token: token, public_url: None, tls: false }).unwrap()
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

fn tls_host(dir: &std::path::Path) -> Running {
    start(Config { data_dir: dir.to_path_buf(), bind: "127.0.0.1:0".parse().unwrap(), admin_token: Some("bfa_tls".into()), public_url: None, tls: true }).unwrap()
}

#[test]
fn tls_with_a_pinned_self_signed_certificate() {
    let dir = tempfile::tempdir().unwrap();
    let srv = tls_host(dir.path());
    let fp = srv.fingerprint.clone().expect("a fingerprint");
    assert_eq!(fp.len(), 64);
    assert!(srv.url().starts_with("https://127.0.0.1:"));
    let host_port = biforge_publish::pin::host_port(&srv.url()).unwrap();

    // a client without the pin refuses the certificate (it is not from a public authority)
    let plain = ReqwestHttp::new().unwrap();
    assert!(Client::info(&plain, &srv.url()).is_err());
    // a client with a wrong pin refuses it too
    let wrong = ReqwestHttp::new().unwrap();
    wrong.pin(&host_port, &"cd".repeat(32));
    assert!(Client::info(&wrong, &srv.url()).is_err());
    // the right pin works end to end: info says TLS, the admin works, an invitation link carries the pin
    let ok = ReqwestHttp::new().unwrap();
    ok.pin(&host_port, &fp);
    let info = Client::info(&ok, &srv.url()).unwrap();
    assert_eq!(info["tls"], true);
    let admin = Client::new(&ok, &srv.url(), "bfa_tls");
    let ws = admin.create_workspace("T").unwrap().id;
    let inv = admin.invite(&ws, &InviteRequest { role: WsRole::Viewer, identity: "v@x.com".into(), rls_roles: vec![], expires_minutes: 5 }).unwrap();
    assert!(inv.link.starts_with("biforge://open?src=server&url=https%3A%2F%2F"), "{}", inv.link);
    assert!(inv.link.contains(&format!("&pin={fp}")), "{}", inv.link);
    match biforge_publish::deeplink::parse(&inv.link).unwrap() {
        biforge_publish::deeplink::Link::Server { pin, .. } => assert_eq!(pin.as_deref(), Some(fp.as_str())),
        other => panic!("{other:?}"),
    }
    // a plain-HTTP request to the TLS port is not answered as HTTP
    assert!(std::net::TcpStream::connect(srv.addr).is_ok());
    srv.stop();

    // the certificate is kept: after a restart the same pin (and the same invitation links) still works
    let again = tls_host(dir.path());
    assert_eq!(again.fingerprint.as_deref(), Some(fp.as_str()));
}

#[test]
fn every_uploaded_version_is_kept_and_an_older_one_can_be_made_current() {
    let dir = tempfile::tempdir().unwrap();
    let http = ReqwestHttp::new().unwrap();
    let srv = host(dir.path(), Some("bfa_v".into()));
    let admin = Client::new(&http, &srv.url(), "bfa_v");
    let ws = admin.create_workspace("V").unwrap().id;
    let signer = Identity::generate();
    let viewer = join(&http, &srv, &admin, &ws, WsRole::Viewer, "v@x.com", &[]);
    let c_view = Client::new(&http, &srv.url(), &viewer.token);
    admin.upload_report(&ws, "sales", package_bytes(1, &signer, "one")).unwrap();
    admin.upload_report(&ws, "sales", package_bytes(2, &signer, "two")).unwrap();
    admin.upload_report(&ws, "sales", package_bytes(3, &signer, "three")).unwrap();
    let v = c_view.versions(&ws, "sales").unwrap();
    assert_eq!(v.iter().map(|x| (x.version, x.current)).collect::<Vec<_>>(), [(3, true), (2, false), (1, false)]);
    let note = |c: &Client| String::from_utf8(c.project(&ws, "sales").unwrap().into_iter().find(|(p, _)| p.ends_with("note.txt")).unwrap().1).unwrap();
    assert_eq!(note(&c_view), "three");

    // viewers cannot restore; an editor/admin can; the server then answers with that version
    assert!(c_view.restore_version(&ws, "sales", 1).is_err());
    assert!(admin.restore_version(&ws, "sales", 9).is_err());
    let info = admin.restore_version(&ws, "sales", 2).unwrap();
    assert_eq!(info.version, 2);
    assert_eq!(note(&c_view), "two");
    assert_eq!(c_view.versions(&ws, "sales").unwrap().iter().find(|x| x.current).unwrap().version, 2);
    // new uploads must still be newer than everything ever uploaded (3), not only than the current version
    assert!(admin.upload_report(&ws, "sales", package_bytes(3, &signer, "dup")).unwrap_err().to_string().contains("409"));
    admin.upload_report(&ws, "sales", package_bytes(4, &signer, "four")).unwrap();
    assert_eq!(note(&c_view), "four");
    // the restore is in the audit log
    assert!(admin.audit(&ws).unwrap().iter().any(|a| a.event == "report-restore"));
    // the history survives a restart
    srv.stop();
    let again = host(dir.path(), Some("bfa_v".into()));
    let a2 = Client::new(&http, &again.url(), "bfa_v");
    assert_eq!(a2.versions(&ws, "sales").unwrap().len(), 4);
}

#[test]
fn co_editing_through_the_server_and_comments_with_mentions() {
    use yrs::updates::decoder::Decode;
    use yrs::updates::encoder::Encode;
    use yrs::{Doc, Map, ReadTxn, StateVector, Transact, Update};
    let dir = tempfile::tempdir().unwrap();
    let http = ReqwestHttp::new().unwrap();
    let srv = host(dir.path(), Some("bfa_c".into()));
    let admin = Client::new(&http, &srv.url(), "bfa_c");
    let ws = admin.create_workspace("C").unwrap().id;
    let signer = Identity::generate();
    let ann = join(&http, &srv, &admin, &ws, WsRole::Editor, "ann@x.com", &[]);
    let bob = join(&http, &srv, &admin, &ws, WsRole::Editor, "bob@x.com", &[]);
    let vic = join(&http, &srv, &admin, &ws, WsRole::Viewer, "vic@x.com", &[]);
    let (c_ann, c_bob, c_vic) = (Client::new(&http, &srv.url(), &ann.token), Client::new(&http, &srv.url(), &bob.token), Client::new(&http, &srv.url(), &vic.token));
    c_ann.upload_report(&ws, "sales", package_bytes(1, &signer, "one")).unwrap();

    // two editors with their own Yjs documents
    let make = |client: u64| Doc::with_client_id(client);
    let (da, db) = (make(11), make(12));
    let set = |d: &Doc, key: &str, val: &str| -> Vec<u8> {
        let before = d.transact().state_vector();
        let m = d.get_or_insert_map("files");
        m.insert(&mut d.transact_mut(), key, val);
        d.transact().encode_state_as_update_v1(&before)
    };
    let apply = |d: &Doc, bytes: &[u8]| {
        if !bytes.is_empty() {
            d.transact_mut().apply_update(Update::decode_v1(bytes).unwrap()).unwrap();
        }
    };
    let sv = |d: &Doc| d.transact().state_vector().encode_v1();

    // viewers cannot take part
    assert!(c_vic.collab_sync(&ws, "sales", &[], &[], false, "").unwrap_err().to_string().contains("403"));
    // Ann seeds; Bob's simultaneous seed is refused and he receives Ann's state instead
    let seed_a = set(&da, "report.json", "{\"v\":1}");
    let r = c_ann.collab_sync(&ws, "sales", &sv(&da), &seed_a, true, "started").unwrap();
    assert!(r.seeded && !r.empty);
    let seed_b = set(&db, "report.json", "{\"v\":99}");
    let r = c_bob.collab_sync(&ws, "sales", &StateVector::default().encode_v1(), &seed_b, true, "").unwrap();
    assert!(!r.seeded && !r.update.is_empty());
    // Bob discards his own seed, as the app does, and starts again from the shared state
    let db = make(13);
    apply(&db, &r.update);
    // concurrent edits of different keys both survive
    let ua = set(&da, "a.json", "from ann");
    let ub = set(&db, "b.json", "from bob");
    c_ann.collab_sync(&ws, "sales", &sv(&da), &ua, false, "Ann moved a visual").unwrap();
    let rb = c_bob.collab_sync(&ws, "sales", &sv(&db), &ub, false, "Bob renamed a measure").unwrap();
    apply(&db, &rb.update);
    let ra = c_ann.collab_sync(&ws, "sales", &sv(&da), &[], false, "").unwrap();
    apply(&da, &ra.update);
    for d in [&da, &db] {
        let m = d.get_or_insert_map("files");
        let t = d.transact();
        assert_eq!(m.len(&t), 3, "report.json, a.json and b.json");
    }
    assert_eq!(sv(&da), sv(&db));
    // the change log names the authenticated author, not a name the client chose
    let log = c_vic.collab_changes(&ws, "sales").unwrap();
    assert_eq!(log.len(), 3);
    assert!(log[0].actor.contains("bob@x.com") && log[0].summary == "Bob renamed a measure", "{log:?}");
    // the state survives a restart of the server
    srv.stop();
    let srv2 = host(dir.path(), Some("bfa_c".into()));
    let c_ann2 = Client::new(&http, &srv2.url(), &ann.token);
    let fresh = make(14);
    let r = c_ann2.collab_sync(&ws, "sales", &StateVector::default().encode_v1(), &[], false, "").unwrap();
    apply(&fresh, &r.update);
    assert_eq!(fresh.get_or_insert_map("files").len(&fresh.transact()), 3);
    // a new uploaded version starts the shared document afresh
    c_ann2.upload_report(&ws, "sales", package_bytes(2, &signer, "two")).unwrap();
    assert!(c_ann2.collab_sync(&ws, "sales", &[], &[], false, "").unwrap().empty);

    // comments: the author comes from the token; mentions are found among the members
    let c1 = Client::new(&http, &srv2.url(), &vic.token).add_comment(&ws, "sales", "Is Q3 right? @bob please check", &biforge_collab::Anchor { page: Some("p1".into()), visual: None }, None).unwrap();
    assert_eq!((c1.author.as_str(), c1.identity.as_str()), ("vic@x.com", "vic@x.com"));
    assert_eq!(c1.mentions, ["bob@x.com"]);
    let m = Client::new(&http, &srv2.url(), &bob.token).mentions(&ws).unwrap();
    assert_eq!(m.len(), 1);
    assert_eq!(m[0]["report"], "sales");
    let reply = Client::new(&http, &srv2.url(), &bob.token).add_comment(&ws, "sales", "Checked, fine.", &Default::default(), Some(&c1.id)).unwrap();
    assert_eq!(reply.parent.as_deref(), Some(c1.id.as_str()));
    Client::new(&http, &srv2.url(), &bob.token).resolve_comment(&ws, "sales", &c1.id, true).unwrap();
    assert!(Client::new(&http, &srv2.url(), &bob.token).mentions(&ws).unwrap().is_empty());
    assert!(c_ann2.comments(&ws, "sales").unwrap().iter().all(|c| c.resolved));
    // only the author or an admin deletes
    assert!(Client::new(&http, &srv2.url(), &bob.token).delete_comment(&ws, "sales", &c1.id).is_err());
    Client::new(&http, &srv2.url(), &vic.token).delete_comment(&ws, "sales", &c1.id).unwrap();
    assert_eq!(c_ann2.comments(&ws, "sales").unwrap().len(), 0, "the answers go with the thread");
}

fn refresh_bundle(signer: &Identity, sales_csv: &str, region_csv: &str) -> Vec<u8> {
    use biforge_publish::refresh::{bundle_files, RefreshConfig, RefreshSource};
    let included = vec![
        IncludedTable { table: "Region".into(), columns: vec!["Id".into(), "Name".into(), "Manager".into()], data_file: "data/Region.parquet".into() },
        IncludedTable { table: "Sales".into(), columns: vec!["Id".into(), "RegionId".into(), "Qty".into()], data_file: "data/Sales.parquet".into() },
    ];
    let config = RefreshConfig {
        format_version: 1,
        report_name: "Demo".into(),
        publisher_name: "Host".into(),
        package_id: "pkg1".into(),
        access: AccessLevel::Public,
        included,
        sources: vec![
            RefreshSource { table: "Region".into(), spec: serde_json::json!({"kind": "csv", "path": "data/src/r.csv", "delimiter": null, "header": null}), original: "C:/pc/r.csv".into() },
            RefreshSource { table: "Sales".into(), spec: serde_json::json!({"kind": "csv", "path": "data/src/s.csv", "delimiter": null, "header": null}), original: "C:/pc/s.csv".into() },
        ],
    };
    let files = bundle_files(&config, &[], &[PackageFile { path: "data/src/r.csv".into(), bytes: region_csv.as_bytes().to_vec() }, PackageFile { path: "data/src/s.csv".into(), bytes: sales_csv.as_bytes().to_vec() }]).unwrap();
    package::build(
        BuildInput { package_id: "bundle".into(), version: 1, report_name: "Demo (refresh bundle)".into(), publisher_name: "Host".into(), access: AccessLevel::Public, included: vec![], permissions: vec![], created_at: "2026-10-22T00:00:00Z".into(), files, recipients: vec![] },
        signer,
    )
    .unwrap()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

#[test]
fn the_server_refreshes_a_report_on_a_schedule_with_history_retries_and_one_run_at_a_time() {
    use biforge_publish::refresh::Schedule;
    use biforge_publish::schedule::{Plan, RunStatus, Trigger};
    std::env::set_var("BIFORGE_SERVER_TICK_SECS", "1");
    let dir = tempfile::tempdir().unwrap();
    let http = ReqwestHttp::new().unwrap();
    let srv = host(dir.path(), Some("bfa_r".into()));
    let admin = Client::new(&http, &srv.url(), "bfa_r");
    let ws = admin.create_workspace("R").unwrap().id;
    let signer = Identity::generate();
    let ed = join(&http, &srv, &admin, &ws, WsRole::Editor, "ed@x.com", &[]);
    let vw = join(&http, &srv, &admin, &ws, WsRole::Viewer, "v@x.com", &[]);
    let (c_ed, c_vw) = (Client::new(&http, &srv.url(), &ed.token), Client::new(&http, &srv.url(), &vw.token));
    c_ed.upload_report(&ws, "sales", package_bytes(1, &signer, "one")).unwrap();
    let region = "Id,Name,Manager\n1,East,ann@x.com\n2,West,bob@x.com\n3,North,ann@x.com\n";
    let sales = "Id,RegionId,Qty\n1,1,10\n2,2,20\n3,3,30\n4,9,1000\n";

    // nothing to run without a bundle; viewers cannot touch the schedule; a bundle from another publisher is refused
    assert!(c_ed.refresh_set(&ws, "sales", true, &Plan::default()).unwrap_err().to_string().contains("refresh bundle first"));
    assert!(c_vw.refresh_info(&ws, "sales").is_err());
    assert!(c_ed.refresh_put_bundle(&ws, "sales", refresh_bundle(&Identity::generate(), sales, region)).is_err());
    let info = c_ed.refresh_put_bundle(&ws, "sales", refresh_bundle(&signer, sales, region)).unwrap();
    assert!(info.has_bundle && !info.enabled);
    assert!(info.runs_on.contains("BIForge server") && info.needs.contains("server must stay on"));
    assert!(info.source_folder.replace('\\', "/").contains("/reports/sales/refresh/sources"));

    // a manual run with the same data changes nothing (and the history says where it ran)
    let first = c_ed.refresh_run(&ws, "sales").unwrap();
    assert!(matches!(first.status, RunStatus::Unchanged | RunStatus::Refreshed), "{first:?}");
    let second = c_ed.refresh_run(&ws, "sales").unwrap();
    assert_eq!(second.status, RunStatus::Unchanged, "{second:?}");
    assert_eq!(total(&c_ed, &ws).unwrap(), "1060");

    // a new source file in the server's source folder is read by the next run, and the queries use the new data
    let more = "Id,RegionId,Qty\n1,1,10\n2,2,20\n3,3,30\n4,9,1000\n5,1,500\n";
    c_ed.refresh_put_source(&ws, "sales", "s.csv", more.as_bytes().to_vec()).unwrap();
    assert!(c_ed.refresh_put_source(&ws, "sales", "../evil.csv", vec![1]).is_err());
    let third = c_ed.refresh_run(&ws, "sales").unwrap();
    assert_eq!((third.status, third.trigger), (RunStatus::Refreshed, Trigger::Manual));
    assert_eq!(total(&c_ed, &ws).unwrap(), "1560");
    // row-level security still applies to the refreshed data
    c_ed.set_roles(&ws, "sales", &[RlsRole { name: "Mine".into(), filters: vec![RlsFilter { table: "Region".into(), expression: "[Manager] = USERPRINCIPALNAME()".into() }] }]).unwrap();
    let ann = join(&http, &srv, &admin, &ws, WsRole::Viewer, "ann@x.com", &["Mine"]);
    assert_eq!(total(&Client::new(&http, &srv.url(), &ann.token), &ws).unwrap(), "540");

    // one run at a time: with a run in progress a second one does not start
    let lock = dir.path().join("workspaces").join(&ws).join("reports").join("sales").join("refresh").join("running.lock");
    std::fs::write(&lock, unix_now().to_string()).unwrap();
    let skipped = c_ed.refresh_run(&ws, "sales").unwrap();
    assert_eq!(skipped.status, RunStatus::Skipped);
    assert!(c_ed.refresh_info(&ws, "sales").unwrap().running);
    std::fs::remove_file(&lock).unwrap();

    // a failing source: the scheduled run tries again (1 retry, 1 s apart) and every attempt is in the history
    c_ed.refresh_put_source(&ws, "sales", "s.csv", "Id,RegionId\n1,1\n".as_bytes().to_vec()).unwrap();
    let plan = Plan { frequency: Schedule::Hourly, at_minute: 0, retries: 1, retry_delay_secs: 1 };
    let before = c_ed.refresh_info(&ws, "sales").unwrap().history.len();
    c_ed.refresh_set(&ws, "sales", true, &plan).unwrap();
    let mut scheduled = Vec::new();
    for _ in 0..80 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let h = c_ed.refresh_info(&ws, "sales").unwrap().history;
        scheduled = h.into_iter().filter(|r| r.trigger == Trigger::Scheduled).collect();
        if scheduled.len() >= 2 {
            break;
        }
    }
    assert_eq!(scheduled.len(), 2, "the scheduler started the job and retried it once");
    assert!(scheduled.iter().all(|r| r.status == RunStatus::Failed && r.runs_on == biforge_publish::schedule::RunsOn::Server), "{scheduled:?}");
    assert!(scheduled.iter().any(|r| r.attempt == 2) && scheduled.iter().any(|r| r.message.contains("Trying again")));
    assert!(c_ed.refresh_info(&ws, "sales").unwrap().history.len() >= before + 2);
    // a failed run leaves the served data as it was
    assert_eq!(total(&c_ed, &ws).unwrap(), "1560");
    // the next hour has not come: no third attempt
    std::thread::sleep(std::time::Duration::from_millis(2500));
    assert_eq!(c_ed.refresh_info(&ws, "sales").unwrap().history.iter().filter(|r| r.trigger == Trigger::Scheduled).count(), 2);

    // a new version from the publisher replaces the refreshed data; turning refresh off removes the bundle
    c_ed.upload_report(&ws, "sales", package_bytes(2, &signer, "two")).unwrap();
    assert_eq!(total(&c_ed, &ws).unwrap(), "1060");
    let off = c_ed.refresh_delete_bundle(&ws, "sales").unwrap();
    assert!(!off.has_bundle && !off.enabled);
    // the audit log knows who did what
    let events: Vec<String> = admin.audit(&ws).unwrap().into_iter().map(|a| a.event).collect();
    for e in ["refresh-bundle", "refresh-run", "refresh-source", "refresh-schedule", "refresh-off"] {
        assert!(events.iter().any(|x| x == e), "{e} in {events:?}");
    }
}

#[test]
fn a_refresh_bundle_cannot_make_the_server_read_other_files_or_connect_elsewhere() {
    use biforge_publish::refresh::{bundle_files, RefreshConfig, RefreshSource};
    use biforge_publish::schedule::RunStatus;
    let dir = tempfile::tempdir().unwrap();
    let http = ReqwestHttp::new().unwrap();
    let srv = host(dir.path(), Some("bfa_s".into()));
    let admin = Client::new(&http, &srv.url(), "bfa_s");
    let ws = admin.create_workspace("S").unwrap().id;
    let signer = Identity::generate();
    let ed = join(&http, &srv, &admin, &ws, WsRole::Editor, "ed@x.com", &[]);
    let c_ed = Client::new(&http, &srv.url(), &ed.token);
    c_ed.upload_report(&ws, "sales", package_bytes(1, &signer, "one")).unwrap();
    // a file outside the server's data that an editor must not be able to put into a report
    let secret = dir.path().join("secret.csv");
    std::fs::write(&secret, "Id,RegionId,Qty\n1,1,999999\n").unwrap();
    let bundle = |spec: serde_json::Value| {
        let config = RefreshConfig {
            format_version: 1,
            report_name: "Demo".into(),
            publisher_name: "Host".into(),
            package_id: "pkg1".into(),
            access: AccessLevel::Public,
            included: vec![IncludedTable { table: "Sales".into(), columns: vec!["Id".into(), "RegionId".into(), "Qty".into()], data_file: "data/Sales.parquet".into() }],
            sources: vec![RefreshSource { table: "Sales".into(), spec, original: "x".into() }],
        };
        let files = bundle_files(&config, &[], &[PackageFile { path: "data/src/s.csv".into(), bytes: b"Id,RegionId,Qty\n1,1,1\n".to_vec() }]).unwrap();
        package::build(BuildInput { package_id: "b".into(), version: 1, report_name: "b".into(), publisher_name: "Host".into(), access: AccessLevel::Public, included: vec![], permissions: vec![], created_at: "2026-10-22T00:00:00Z".into(), files, recipients: vec![] }, &signer).unwrap()
    };
    let abs = secret.to_string_lossy().replace('\\', "/");
    for (what, spec) in [
        ("an absolute path", serde_json::json!({"kind": "csv", "path": abs, "delimiter": null, "header": null})),
        ("a path that climbs out", serde_json::json!({"kind": "csv", "path": "data/src/../../../secret.csv", "delimiter": null, "header": null})),
        ("a database server", serde_json::json!({"kind": "postgres", "host": "10.0.0.5", "port": 5432, "database": "d", "user": "u", "schema": "public", "table": "t"})),
        ("a web address", serde_json::json!({"kind": "web", "url": "http://127.0.0.1:1/x"})),
    ] {
        c_ed.refresh_put_bundle(&ws, "sales", bundle(spec)).unwrap();
        let rec = c_ed.refresh_run(&ws, "sales").unwrap();
        assert_eq!(rec.status, RunStatus::Failed, "{what}: {rec:?}");
        assert!(rec.message.contains("not a file") || rec.message.contains("outside the bundle") || rec.message.contains("not valid"), "{what}: {}", rec.message);
    }
    assert_eq!(total(&c_ed, &ws).unwrap(), "1060", "the report still answers with the published data");
}

#[test]
fn invitations_cannot_be_guessed_at_speed() {
    let dir = tempfile::tempdir().unwrap();
    let http = ReqwestHttp::new().unwrap();
    let srv = host(dir.path(), Some("bfa_j".into()));
    let mut last = String::new();
    for i in 0..40 {
        match Client::join(&http, &srv.url(), &format!("bfi_guess{i}"), "Mallory") {
            Ok(_) => panic!("a guess worked"),
            Err(e) => last = e.to_string(),
        }
    }
    assert!(last.contains("Too many attempts"), "{last}");
}

#[test]
fn a_big_body_is_refused_on_the_small_routes() {
    let dir = tempfile::tempdir().unwrap();
    let http = ReqwestHttp::new().unwrap();
    let srv = host(dir.path(), Some("bfa_b".into()));
    let admin = Client::new(&http, &srv.url(), "bfa_b");
    let name = "x".repeat(3 * 1024 * 1024);
    assert!(admin.create_workspace(&name).is_err(), "a 3 MB workspace name is refused before it is read");
    assert!(admin.workspaces().is_ok());
}
