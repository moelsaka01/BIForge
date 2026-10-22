//! Shared state for co-editing. The app builds the document with Yjs (the same update format as `yrs`), so the
//! relays here only merge opaque updates: they keep one [`SharedDoc`] per report, apply what editors push and hand
//! out what an editor is missing. Merging is conflict-free: any order of the same updates gives the same document.

pub mod comments;
pub use comments::{Anchor, Comment, CommentError, CommentStore, Person};

use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollabError(pub String);

impl std::fmt::Display for CollabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CollabError {}

fn bad(what: &str, e: impl std::fmt::Display) -> CollabError {
    CollabError(format!("{what}: {e}"))
}

#[derive(Debug, Clone, Default)]
pub struct SyncRequest {
    pub state_vector: Vec<u8>,
    pub update: Vec<u8>,
    pub seed: bool,
}

#[derive(Debug, Clone)]
pub struct SyncReply {
    pub update: Vec<u8>,
    pub state_vector: Vec<u8>,
    pub seeded: bool,
    pub empty: bool,
}

/// A document that is only merged, never read: the state of a shared project.
pub struct SharedDoc {
    doc: Doc,
}

impl Default for SharedDoc {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedDoc {
    pub fn new() -> Self {
        Self { doc: Doc::new() }
    }

    /// Restores a document from `full_state()` bytes.
    pub fn from_state(bytes: &[u8]) -> Result<Self, CollabError> {
        let d = Self::new();
        d.apply(bytes)?;
        Ok(d)
    }

    /// Merges one Yjs update (v1). A corrupt update is refused and leaves the document unchanged.
    pub fn apply(&self, update: &[u8]) -> Result<(), CollabError> {
        let u = Update::decode_v1(update).map_err(|e| bad("the update is not valid", e))?;
        self.doc.transact_mut().apply_update(u).map_err(|e| bad("the update could not be applied", e))
    }

    /// The state vector (what this document already contains), to send with a request for the difference.
    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    /// Everything a peer with state vector `sv` (empty: nothing) is missing.
    pub fn diff_since(&self, sv: &[u8]) -> Result<Vec<u8>, CollabError> {
        let sv = if sv.is_empty() { StateVector::default() } else { StateVector::decode_v1(sv).map_err(|e| bad("the state vector is not valid", e))? };
        Ok(self.doc.transact().encode_state_as_update_v1(&sv))
    }

    /// The whole state, for storing or for a peer that joins late.
    pub fn full_state(&self) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(&StateVector::default())
    }

    /// One round trip of the sync protocol. The client sends the state vector it has *after* its own edits, the update
    /// it made since the last round trip (maybe empty) and whether that update is the first state of the document.
    /// A seed is accepted only while the shared document is still empty, so two editors who open the same report at
    /// the same moment cannot both seed it (which would double its content). The reply carries what the client is
    /// missing; `seeded` says whether a seed was taken, `empty` whether the document has any content.
    pub fn sync(&self, req: &SyncRequest) -> Result<SyncReply, CollabError> {
        let mut seeded = false;
        if !req.update.is_empty() {
            if req.seed {
                if self.is_empty() {
                    self.apply(&req.update)?;
                    seeded = true;
                }
            } else {
                self.apply(&req.update)?;
            }
        }
        Ok(SyncReply { update: self.diff_since(&req.state_vector)?, state_vector: self.state_vector(), seeded, empty: self.is_empty() })
    }

    /// True while nothing was ever merged (a seed is still needed).
    pub fn is_empty(&self) -> bool {
        self.doc.transact().state_vector() == StateVector::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{GetString, Map, Text};

    fn edit(doc: &Doc, f: impl FnOnce(&mut yrs::TransactionMut)) -> Vec<u8> {
        let before = doc.transact().state_vector();
        f(&mut doc.transact_mut());
        doc.transact().encode_state_as_update_v1(&before)
    }

    #[test]
    fn concurrent_edits_merge_in_any_order() {
        let (a, b) = (Doc::with_client_id(1), Doc::with_client_id(2));
        let (ma, mb) = (a.get_or_insert_map("files"), b.get_or_insert_map("files"));
        let ua = edit(&a, |t| {
            ma.insert(t, "a.json", "from a");
        });
        let ub = edit(&b, |t| {
            mb.insert(t, "b.json", "from b");
        });
        let one = SharedDoc::new();
        one.apply(&ua).unwrap();
        one.apply(&ub).unwrap();
        let two = SharedDoc::new();
        two.apply(&ub).unwrap();
        two.apply(&ua).unwrap();
        assert_eq!(one.full_state().len(), two.full_state().len());
        assert_eq!(one.state_vector(), two.state_vector());
        // a peer that has only a's update asks for the difference and gets b's
        let only_a = SharedDoc::new();
        only_a.apply(&ua).unwrap();
        let missing = one.diff_since(&only_a.state_vector()).unwrap();
        only_a.apply(&missing).unwrap();
        assert_eq!(only_a.state_vector(), one.state_vector());
    }

    #[test]
    fn text_edits_by_two_peers_both_survive() {
        let seed = Doc::with_client_id(1);
        let t = seed.get_or_insert_text("tmdl");
        let u0 = edit(&seed, |tx| t.insert(tx, 0, "measure Total = 1"));
        let (a, b) = (Doc::with_client_id(2), Doc::with_client_id(3));
        for d in [&a, &b] {
            d.transact_mut().apply_update(Update::decode_v1(&u0).unwrap()).unwrap();
        }
        let (ta, tb) = (a.get_or_insert_text("tmdl"), b.get_or_insert_text("tmdl"));
        let ua = edit(&a, |tx| ta.insert(tx, 0, "// by a\n"));
        let ub = edit(&b, |tx| tb.insert(tx, 17, " // by b"));
        let relay = SharedDoc::new();
        for u in [&u0, &ua, &ub] {
            relay.apply(u).unwrap();
        }
        let fresh = Doc::new();
        fresh.transact_mut().apply_update(Update::decode_v1(&relay.full_state()).unwrap()).unwrap();
        let s = fresh.get_or_insert_text("tmdl").get_string(&fresh.transact());
        assert!(s.contains("// by a") && s.contains("// by b") && s.contains("measure Total = 1"), "{s}");
    }

    #[test]
    fn only_the_first_seed_is_taken() {
        let (a, b) = (Doc::with_client_id(1), Doc::with_client_id(2));
        let (ma, mb) = (a.get_or_insert_map("files"), b.get_or_insert_map("files"));
        let ua = edit(&a, |t| {
            ma.insert(t, "x", "a");
        });
        let ub = edit(&b, |t| {
            mb.insert(t, "x", "b");
        });
        let relay = SharedDoc::new();
        let r1 = relay.sync(&SyncRequest { state_vector: a.transact().state_vector().encode_v1(), update: ua, seed: true }).unwrap();
        assert!(r1.seeded && !r1.empty);
        // the second editor tried to seed at the same time: refused, and the reply carries the real state
        let r2 = relay.sync(&SyncRequest { state_vector: StateVector::default().encode_v1(), update: ub, seed: true }).unwrap();
        assert!(!r2.seeded && !r2.update.is_empty());
        // an ordinary update is always merged
        let uc = edit(&b, |t| {
            mb.insert(t, "y", "b2");
        });
        let r3 = relay.sync(&SyncRequest { state_vector: relay.state_vector(), update: uc, seed: false }).unwrap();
        assert!(!r3.seeded);
    }

    #[test]
    fn a_corrupt_update_is_refused_and_state_survives_a_round_trip() {
        let d = SharedDoc::new();
        assert!(d.is_empty());
        assert!(d.apply(&[1, 2, 3, 4, 5]).is_err());
        assert!(d.is_empty());
        let a = Doc::with_client_id(7);
        let m = a.get_or_insert_map("x");
        let u = edit(&a, |t| {
            m.insert(t, "k", 5);
        });
        d.apply(&u).unwrap();
        assert!(!d.is_empty());
        let again = SharedDoc::from_state(&d.full_state()).unwrap();
        assert_eq!(again.state_vector(), d.state_vector());
        assert!(d.diff_since(&[255, 255]).is_err());
    }
}
