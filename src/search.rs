use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct SearchResult {
    pub id: String,
    pub score: f64,
}

#[derive(Clone, Debug, Default)]
pub struct TrigramIndex {
    documents: Vec<Document>,
    postings: HashMap<String, Vec<usize>>,
    indexed: bool,
}

#[derive(Clone, Debug)]
struct Document {
    id: String,
    text: String,
    trigrams: HashSet<String>,
}

impl TrigramIndex {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, id: impl Into<String>, text: impl AsRef<str>) {
        let text = normalize(text.as_ref());
        self.documents.push(Document {
            id: id.into(),
            text,
            trigrams: HashSet::new(),
        });
        self.postings.clear();
        self.indexed = false;
    }

    #[must_use]
    pub fn search(&mut self, query: &str, limit: usize) -> Vec<SearchResult> {
        let query = normalize(query);
        if query.is_empty() || limit == 0 {
            return Vec::new();
        }

        let query_trigrams = trigrams(&query);
        let candidates: HashSet<usize> = if query.chars().count() < 3 {
            (0..self.documents.len()).collect()
        } else {
            self.ensure_index();
            query_trigrams
                .iter()
                .filter_map(|trigram| self.postings.get(trigram))
                .flatten()
                .copied()
                .collect()
        };

        let mut results = candidates
            .into_iter()
            .filter_map(|document_id| {
                let document = &self.documents[document_id];
                score(document, &query, &query_trigrams).map(|score| SearchResult {
                    id: document.id.clone(),
                    score,
                })
            })
            .collect::<Vec<_>>();

        results.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(Ordering::Equal)
                .then_with(|| left.id.cmp(&right.id))
        });
        results.truncate(limit);
        results
    }

    fn ensure_index(&mut self) {
        if self.indexed {
            return;
        }

        self.postings.clear();
        for (document_id, document) in self.documents.iter_mut().enumerate() {
            document.trigrams = trigrams(&document.text);
            for trigram in &document.trigrams {
                self.postings
                    .entry(trigram.clone())
                    .or_default()
                    .push(document_id);
            }
        }
        self.indexed = true;
    }
}

fn score(document: &Document, query: &str, query_trigrams: &HashSet<String>) -> Option<f64> {
    if query.chars().count() < 3 {
        return document.text.contains(query).then_some(1.0);
    }

    let overlap = query_trigrams.intersection(&document.trigrams).count();
    if overlap == 0 {
        return None;
    }

    let coverage = overlap as f64 / query_trigrams.len() as f64;
    if coverage < 0.3 {
        return None;
    }
    let exact_phrase = f64::from(document.text.contains(query));
    let exact_word = f64::from(document.text.split_whitespace().any(|word| word == query));
    Some(coverage + exact_phrase + exact_word)
}

fn normalize(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut separator = true;

    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            result.push(character);
            separator = false;
        } else if !separator {
            result.push(' ');
            separator = true;
        }
    }

    result.trim().to_owned()
}

fn trigrams(value: &str) -> HashSet<String> {
    let characters = value.chars().collect::<Vec<_>>();
    characters
        .windows(3)
        .map(|window| window.iter().collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::TrigramIndex;

    #[test]
    fn finds_an_element_by_its_fields() {
        let mut index = TrigramIndex::new();
        index.add("people", "people person name email address");
        index.add("auctions", "auctions item seller bidder price");

        let results = index.search("email", 10);

        assert_eq!(results[0].id, "people");
    }

    #[test]
    fn ranks_a_close_spelling() {
        let mut index = TrigramIndex::new();
        index.add("categories", "categories category description");
        index.add("people", "people person profile");

        let results = index.search("catgory", 10);

        assert_eq!(results[0].id, "categories");
    }

    #[test]
    fn creates_postings_when_search_starts() {
        let mut index = TrigramIndex::new();
        index.add("pathways", "pathway component organism");

        assert!(index.postings.is_empty());
        let _ = index.search("pathway", 10);
        assert!(!index.postings.is_empty());
    }

    #[test]
    fn excludes_weak_trigram_matches() {
        let mut index = TrigramIndex::new();
        index.add("pathways", "pathway component organism");
        index.add("evidence", "evidence confidence publication");

        let results = index.search("pathwy component", 10);

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "pathways");
    }
}
