//! Comments on a report, with mentions, shared through a host that stamps who wrote them.
//!
//! The same store serves a BIForge server (REST), a direct session (the host answers its guests) and a single PC
//! (comments kept next to the project, visible only on this PC). The caller supplies the author; the store never
//! trusts a name that comes from the text of a request.

use serde::{Deserialize, Serialize};

const MAX_TEXT: usize = 4000;
const MAX_COMMENTS: usize = 5000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    /// Page name (id) the comment is about.
    #[serde(default)]
    pub page: Option<String>,
    /// Visual name (id) on that page.
    #[serde(default)]
    pub visual: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    /// The first comment of the thread this one answers (an answer to an answer joins the same thread).
    #[serde(default)]
    pub parent: Option<String>,
    /// Display name of the author.
    pub author: String,
    /// Identity of the author (what the host knows them by).
    pub identity: String,
    pub text: String,
    #[serde(default)]
    pub anchor: Anchor,
    /// Identities mentioned with @name in the text.
    #[serde(default)]
    pub mentions: Vec<String>,
    pub created_at: String,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub resolved_by: Option<String>,
}

/// Someone who can be mentioned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Person {
    pub identity: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentError(pub String);

impl std::fmt::Display for CommentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CommentError {}

fn fail<T>(m: &str) -> Result<T, CommentError> {
    Err(CommentError(m.to_string()))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CommentStore {
    items: Vec<Comment>,
    #[serde(default)]
    next: u64,
}

/// The identities mentioned in `text`. `@ann` matches a person whose name (no spaces, any case), first name, or the
/// part of whose identity before the `@` is `ann`; `@ann@x.com` matches the whole identity. Unknown names mention
/// nobody.
pub fn find_mentions(text: &str, people: &[Person]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let b: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '@' && (i == 0 || !b[i - 1].is_alphanumeric()) {
            let mut j = i + 1;
            while j < b.len() && (b[j].is_alphanumeric() || matches!(b[j], '.' | '_' | '-' | '@' | '+')) {
                j += 1;
            }
            // trailing '.' or '-' is punctuation
            let mut tok: String = b[i + 1..j].iter().collect();
            while tok.ends_with('.') || tok.ends_with('-') {
                tok.pop();
            }
            let t = tok.to_lowercase();
            if !t.is_empty() {
                for p in people {
                    let id = p.identity.to_lowercase();
                    let local = id.split('@').next().unwrap_or("").to_string();
                    let name = p.name.to_lowercase().replace(' ', "");
                    let first = p.name.to_lowercase().split_whitespace().next().unwrap_or("").to_string();
                    if (t == id || t == local || t == name || t == first) && !out.contains(&p.identity) {
                        out.push(p.identity.clone());
                    }
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

impl CommentStore {
    pub fn from_json(bytes: &[u8]) -> Self {
        serde_json::from_slice(bytes).unwrap_or_default()
    }
    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(self).unwrap_or_default()
    }
    pub fn list(&self) -> Vec<Comment> {
        self.items.clone()
    }
    pub fn get(&self, id: &str) -> Option<&Comment> {
        self.items.iter().find(|c| c.id == id)
    }

    /// Adds a comment. `author_name` and `identity` come from the host's own record of the person.
    #[allow(clippy::too_many_arguments)]
    pub fn add(&mut self, author_name: &str, identity: &str, text: &str, anchor: Anchor, parent: Option<&str>, people: &[Person], now: &str) -> Result<Comment, CommentError> {
        let text = text.trim();
        if text.is_empty() {
            return fail("Write something first.");
        }
        if text.chars().count() > MAX_TEXT {
            return fail("A comment can have up to 4000 characters.");
        }
        if self.items.len() >= MAX_COMMENTS {
            return fail("This report has too many comments. Delete resolved ones first.");
        }
        let parent = match parent {
            Some(p) => {
                let Some(c) = self.get(p) else { return fail("The comment you answer no longer exists.") };
                Some(c.parent.clone().unwrap_or_else(|| c.id.clone()))
            }
            None => None,
        };
        self.next += 1;
        let c = Comment {
            id: format!("c{}", self.next),
            parent,
            author: author_name.chars().filter(|c| !c.is_control()).take(100).collect(),
            identity: identity.chars().take(200).collect(),
            text: text.to_string(),
            anchor,
            mentions: find_mentions(text, people),
            created_at: now.to_string(),
            resolved: false,
            resolved_by: None,
        };
        self.items.push(c.clone());
        Ok(c)
    }

    /// Resolves or reopens a thread (the first comment and its answers).
    pub fn set_resolved(&mut self, id: &str, resolved: bool, by: &str) -> Result<(), CommentError> {
        let Some(root) = self.get(id).map(|c| c.parent.clone().unwrap_or_else(|| c.id.clone())) else { return fail("This comment no longer exists.") };
        for c in self.items.iter_mut().filter(|c| c.id == root || c.parent.as_deref() == Some(root.as_str())) {
            c.resolved = resolved;
            c.resolved_by = if resolved { Some(by.to_string()) } else { None };
        }
        Ok(())
    }

    /// Deletes a comment (and the answers to it). Only its author or an administrator may.
    pub fn delete(&mut self, id: &str, identity: &str, is_admin: bool) -> Result<(), CommentError> {
        let Some(c) = self.get(id) else { return fail("This comment no longer exists.") };
        if !is_admin && c.identity != identity {
            return fail("Only the author or an administrator can delete a comment.");
        }
        self.items.retain(|c| c.id != id && c.parent.as_deref() != Some(id));
        Ok(())
    }

    /// Unresolved comments by others that mention this identity.
    pub fn mentioning(&self, identity: &str) -> Vec<Comment> {
        self.items.iter().filter(|c| !c.resolved && c.identity != identity && c.mentions.iter().any(|m| m == identity)).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn people() -> Vec<Person> {
        vec![Person { identity: "ann@x.com".into(), name: "Ann Lee".into() }, Person { identity: "bob@x.com".into(), name: "Bob".into() }]
    }

    #[test]
    fn mentions_match_names_and_identities_only_for_known_people() {
        let p = people();
        assert_eq!(find_mentions("thanks @ann and @Bob.", &p), ["ann@x.com", "bob@x.com"]);
        assert_eq!(find_mentions("@ann@x.com please look", &p), ["ann@x.com"]);
        assert_eq!(find_mentions("@annlee check", &p), ["ann@x.com"]);
        assert!(find_mentions("mail me at me@bob.com or @nobody", &p).is_empty());
        assert!(find_mentions("no mentions here", &p).is_empty());
    }

    #[test]
    fn threads_resolve_together_and_only_the_author_or_an_admin_deletes() {
        let mut s = CommentStore::default();
        let p = people();
        let first = s.add("Ann Lee", "ann@x.com", "Why is Q3 low? @bob", Anchor { page: Some("p1".into()), visual: Some("v1".into()) }, None, &p, "t1").unwrap();
        assert_eq!(first.mentions, ["bob@x.com"]);
        let second = s.add("Bob", "bob@x.com", "Fixed it.", Anchor::default(), Some(&first.id), &p, "t2").unwrap();
        // an answer to an answer joins the first thread
        let third = s.add("Ann Lee", "ann@x.com", "Thanks", Anchor::default(), Some(&second.id), &p, "t3").unwrap();
        assert_eq!(third.parent.as_deref(), Some(first.id.as_str()));
        assert_eq!(s.mentioning("bob@x.com").len(), 1);
        s.set_resolved(&second.id, true, "bob@x.com").unwrap();
        assert!(s.list().iter().all(|c| c.resolved));
        assert!(s.mentioning("bob@x.com").is_empty(), "resolved threads leave the inbox");
        s.set_resolved(&first.id, false, "bob@x.com").unwrap();
        assert!(s.list().iter().all(|c| !c.resolved));
        assert!(s.delete(&second.id, "ann@x.com", false).is_err());
        s.delete(&second.id, "admin", true).unwrap();
        assert_eq!(s.list().len(), 2);
        // deleting the first removes the whole thread
        s.delete(&first.id, "ann@x.com", false).unwrap();
        assert!(s.list().is_empty());
    }

    #[test]
    fn bad_input_is_refused_and_the_store_round_trips() {
        let mut s = CommentStore::default();
        let p = people();
        assert!(s.add("A", "a", "   ", Anchor::default(), None, &p, "t").is_err());
        assert!(s.add("A", "a", &"x".repeat(4001), Anchor::default(), None, &p, "t").is_err());
        assert!(s.add("A", "a", "hi", Anchor::default(), Some("nope"), &p, "t").is_err());
        s.add("A\u{7}", "a", "hi", Anchor::default(), None, &p, "t").unwrap();
        let back = CommentStore::from_json(&s.to_json());
        assert_eq!(back.list(), s.list());
        assert_eq!(back.list()[0].author, "A");
        let mut back = back;
        assert_eq!(back.add("A", "a", "again", Anchor::default(), None, &p, "t").unwrap().id, "c2");
    }
}
