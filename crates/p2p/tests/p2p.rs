//! Two endpoints on this machine (direct addresses only, no relay, no internet needed): pairing code, approval, roles,
//! live updates, revocation, expiry and the message when the host cannot be reached.

use std::time::Duration;

use biforge_p2p::*;
use iroh::SecretKey;

fn opts(key: Option<SecretKey>) -> GuestOptions {
    GuestOptions { network: Network::Local, secret_key: key, connect_timeout: Duration::from_secs(5) }
}

async fn host(expires: u64) -> HostSession {
    HostSession::start(b"package-v1".to_vec(), 1, HostOptions { network: Network::Local, expires_in: Duration::from_secs(expires), secret_key: None, host_name: "Host".into() }).await.unwrap()
}

async fn wait_pending(h: &HostSession, n: usize) -> Vec<JoinRequest> {
    for _ in 0..200 {
        let p = h.pending();
        if p.len() >= n {
            return p;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("no join request arrived");
}

async fn wait_for<F: FnMut() -> bool>(what: &str, mut f: F) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn pairing_approval_roles_updates_and_revocation() {
    let h = host(600).await;
    let code = h.pairing().ticket();
    assert!(code.starts_with("BF1T-"));
    assert!(h.pairing().short().starts_with("BF1-"));
    assert_eq!(Pairing::parse(&code).unwrap().secret, h.pairing().secret);

    // a wrong code is refused without ever reaching the host's approval list
    let bad = Pairing { endpoint: Pairing::parse(&code).unwrap().endpoint, secret: "0000000000000000".into() }.ticket();
    let g = Guest::connect(&bad, "Mallory", opts(None)).await.unwrap();
    assert!(matches!(g.wait_decision(Duration::from_secs(5)).await, GuestState::Denied { reason } if reason.contains("not valid")));
    assert!(h.pending().is_empty());
    g.leave().await;

    // a denied request
    let g = Guest::connect(&code, "Dora", opts(None)).await.unwrap();
    let req = wait_pending(&h, 1).await;
    assert_eq!(req[0].name, "Dora");
    h.deny(req[0].id).unwrap();
    assert!(matches!(g.wait_decision(Duration::from_secs(5)).await, GuestState::Denied { .. }));
    g.leave().await;

    // read-only guest: gets the package, then live updates; cannot send changes
    let ann_key = SecretKey::generate();
    let ann = Guest::connect(&code, "Ann", opts(Some(ann_key.clone()))).await.unwrap();
    assert_eq!(ann.state(), GuestState::Waiting, "nothing is shared before the host approves");
    assert!(ann.take_new().is_none());
    let req = wait_pending(&h, 1).await;
    h.approve(req[0].id, Role::ReadOnly).unwrap();
    assert_eq!(ann.wait_decision(Duration::from_secs(5)).await, GuestState::Approved);
    let mut first = None;
    wait_for("the first package", || {
        first = ann.take_new();
        first.is_some()
    })
    .await;
    assert_eq!(first.unwrap(), (1, b"package-v1".to_vec()));
    h.publish(b"package-v2".to_vec(), 2);
    let mut got = None;
    wait_for("the live update", || {
        got = ann.take_new();
        got.is_some()
    })
    .await;
    assert_eq!(got.unwrap(), (2, b"package-v2".to_vec()));
    assert!(ann.push(b"mine".to_vec()).is_err());
    assert_eq!(h.peers().len(), 1);
    assert!(h.peers()[0].connected);

    // edit guest: may send a copy; the host receives it and decides
    let bob = Guest::connect(&code, "Bob", opts(None)).await.unwrap();
    let req = wait_pending(&h, 1).await;
    h.approve(req[0].id, Role::Edit).unwrap();
    assert_eq!(bob.wait_decision(Duration::from_secs(5)).await, GuestState::Approved);
    assert_eq!(bob.role(), Role::Edit);
    bob.push(b"bobs-copy".to_vec()).unwrap();
    wait_for("the pushed copy", || !h.pushes().is_empty()).await;
    let p = h.pushes();
    assert_eq!(p[0].name, "Bob");
    assert_eq!(h.take_push(p[0].id).unwrap(), b"bobs-copy".to_vec());
    assert!(h.pushes().is_empty());
    wait_for("the answer to the push", || bob.take_push_message().is_some()).await;

    // revocation: the connection ends, and the same identity is refused afterwards, even with the code
    let ann_id = h.peers().into_iter().find(|p| p.name == "Ann").unwrap().endpoint_id;
    h.revoke(&ann_id).unwrap();
    wait_for("Ann's access to end", || matches!(ann.state(), GuestState::Ended { .. })).await;
    ann.leave().await;
    let again = Guest::connect(&code, "Ann", opts(Some(ann_key))).await.unwrap();
    assert!(matches!(again.wait_decision(Duration::from_secs(5)).await, GuestState::Denied { reason } if reason.contains("ended your access")));
    again.leave().await;
    // Bob is not affected
    h.publish(b"package-v3".to_vec(), 3);
    wait_for("Bob's update", || bob.take_new().map(|(v, _)| v) == Some(3)).await;

    // stopping the session ends everybody
    h.stop().await;
    wait_for("Bob's access to end", || matches!(bob.state(), GuestState::Ended { .. })).await;
    bob.leave().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_code_is_refused_and_active_guests_are_ended() {
    let h = host(2).await;
    let code = h.pairing().ticket();
    let g = Guest::connect(&code, "Early", opts(None)).await.unwrap();
    let req = wait_pending(&h, 1).await;
    h.approve(req[0].id, Role::ReadOnly).unwrap();
    assert_eq!(g.wait_decision(Duration::from_secs(5)).await, GuestState::Approved);
    tokio::time::sleep(Duration::from_millis(2600)).await;
    wait_for("the session to expire for the guest", || matches!(g.state(), GuestState::Ended { .. })).await;
    let late = Guest::connect(&code, "Late", opts(None)).await.unwrap();
    assert!(matches!(late.wait_decision(Duration::from_secs(5)).await, GuestState::Denied { reason } if reason.contains("expired")));
    late.leave().await;
    g.leave().await;
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_host_gives_the_fallback_message() {
    // a well-formed code for a computer that is not there
    let ghost = SecretKey::generate().public();
    let code = format!("BF1T-{}", {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(r#"{{"id":"{ghost}","addrs":["127.0.0.1:9"],"relay":null,"secret":"0123456789abcdef"}}"#))
    });
    let r = Guest::connect(&code, "Ann", GuestOptions { network: Network::Local, secret_key: None, connect_timeout: Duration::from_secs(3) }).await;
    let msg = r.err().expect("must fail").0;
    assert!(msg.contains("Both computers must be online") && msg.contains("Use another way"), "{msg}");
    assert!(Pairing::parse("hello").is_err());
    assert!(Pairing::parse("BF1-notanid-0123456789").is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn co_editing_and_comments_over_a_direct_session() {
    use yrs::updates::decoder::Decode;
    use yrs::updates::encoder::Encode;
    use yrs::{Doc, Map, ReadTxn, Transact, Update};
    let h = host(600).await;
    let code = h.pairing().ticket();
    let join = |name: &'static str, role: Role| {
        let code = code.clone();
        async move { (name, role, Guest::connect(&code, name, opts(None)).await.unwrap()) }
    };
    let (_, _, ed) = join("Eda", Role::Edit).await;
    let req = wait_pending(&h, 1).await;
    h.approve(req[0].id, Role::Edit).unwrap();
    assert_eq!(ed.wait_decision(Duration::from_secs(5)).await, GuestState::Approved);
    let (_, _, ro) = join("Rob", Role::ReadOnly).await;
    let req = wait_pending(&h, 1).await;
    h.approve(req[0].id, Role::ReadOnly).unwrap();
    assert_eq!(ro.wait_decision(Duration::from_secs(5)).await, GuestState::Approved);

    let encode = |d: &Doc| d.transact().state_vector().encode_v1();
    let put = |d: &Doc, k: &str, v: &str| {
        let before = d.transact().state_vector();
        d.get_or_insert_map("files").insert(&mut d.transact_mut(), k, v);
        d.transact().encode_state_as_update_v1(&before)
    };
    // the guest with the edit role seeds; the host (also an editor) then receives it and adds its own change
    let de = Doc::with_client_id(21);
    let seed = put(&de, "report.json", "{}");
    let mut blob = encode(&de);
    let sv_len = blob.len();
    blob.extend_from_slice(&seed);
    let (meta, _) = ed.call("collab.sync", &serde_json::json!({"svLen": sv_len, "seed": true, "summary": "Eda started"}), &blob).await.unwrap();
    assert_eq!(meta["seeded"], true);
    let dh = Doc::with_client_id(22);
    let (meta, out) = h.call("collab.sync", &serde_json::json!({"svLen": 0, "seed": false}), &[]).unwrap();
    assert_eq!(meta["empty"], false);
    let sv_n = meta["svLen"].as_u64().unwrap() as usize;
    dh.transact_mut().apply_update(Update::decode_v1(&out[sv_n..]).unwrap()).unwrap();
    assert_eq!(dh.get_or_insert_map("files").len(&dh.transact()), 1);
    let up = put(&dh, "host.json", "x");
    let mut b2 = encode(&dh);
    let l2 = b2.len();
    b2.extend_from_slice(&up);
    h.call("collab.sync", &serde_json::json!({"svLen": l2, "seed": false, "summary": "Host added a file"}), &b2).unwrap();
    // Eda pulls the host's change
    let mut b3 = encode(&de);
    let l3 = b3.len();
    b3.truncate(l3);
    let (m3, out3) = ed.call("collab.sync", &serde_json::json!({"svLen": l3, "seed": false}), &b3).await.unwrap();
    let n3 = m3["svLen"].as_u64().unwrap() as usize;
    de.transact_mut().apply_update(Update::decode_v1(&out3[n3..]).unwrap()).unwrap();
    assert_eq!(de.get_or_insert_map("files").len(&de.transact()), 2);
    // the read-only guest may not take part, but may comment
    let e = ro.call("collab.sync", &serde_json::json!({"svLen": 0}), &[]).await.unwrap_err();
    assert!(e.0.contains("read-only"), "{e}");
    let (c, _) = ro.call("comments.add", &serde_json::json!({"text": "Nice. @host and @eda please look", "anchor": {"page": "p1"}}), &[]).await.unwrap();
    assert_eq!(c["author"], "Rob", "the host stamps the author");
    assert_eq!(c["mentions"].as_array().unwrap().len(), 2);
    let (list, _) = h.call("comments.list", &serde_json::json!({}), &[]).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    let (men, _) = h.call("comments.mentions", &serde_json::json!({}), &[]).unwrap();
    assert_eq!(men.as_array().unwrap().len(), 1, "the host was mentioned");
    // only the author deletes (the host may delete any)
    assert!(ed.call("comments.delete", &serde_json::json!({"id": c["id"]}), &[]).await.is_err());
    ro.call("comments.resolve", &serde_json::json!({"id": c["id"], "resolved": true}), &[]).await.unwrap();
    h.call("comments.delete", &serde_json::json!({"id": c["id"]}), &[]).unwrap();
    // the change log has the authors the host knows
    let (log, _) = ro.call("collab.changes", &serde_json::json!({}), &[]).await.unwrap();
    let log = log.as_array().unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!((log[0]["actor"].as_str().unwrap(), log[1]["actor"].as_str().unwrap()), ("Host", "Eda"));
    // after the host ends Eda's access she can no longer sync
    let peers = h.peers();
    let eda = peers.iter().find(|p| p.name == "Eda").unwrap();
    h.revoke(&eda.endpoint_id).unwrap();
    wait_for("Eda to be ended", || !matches!(ed.state(), GuestState::Approved)).await;
    assert!(ed.call("collab.sync", &serde_json::json!({"svLen": 0}), &[]).await.is_err());
    ed.leave().await;
    ro.leave().await;
    h.stop().await;
}
