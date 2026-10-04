use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::hash::{self, Part, RecordKey};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Config {
    #[serde(default)]
    pub column_overrides: Vec<ColumnOverride>,
    #[serde(default)]
    pub column_substitutions: Vec<Substitution>,
    #[serde(default)]
    pub table_names: Vec<String>,
    #[serde(default)]
    pub table_substitutions: Vec<Substitution>,
    /// Leave `key`, `parent_key` and `path_hash` empty, for callers that do not use them.
    /// Mapping is then about as fast as without stable keys.
    #[serde(default)]
    pub skip_stable_keys: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ColumnOverride {
    pub table: String,
    pub path: String,
    pub target_table: String,
    pub target_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Substitution {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DataType {
    Boolean,
    Number,
    String,
}

impl fmt::Display for DataType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Boolean => "boolean",
            Self::Number => "number",
            Self::String => "string",
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Leaf {
    pub data_type: DataType,
    pub name: String,
    /// Row number of the record within this mapping. Any change to the document changes it.
    pub id: String,
    pub parent_id: Option<String>,
    pub path: String,
    pub value: Value,
    /// Stable 128-bit record key as 32 hex digits. It depends only on the source name and the
    /// record's position in the document structure, not on the document's values.
    /// Empty when [`Config::skip_stable_keys`] is set.
    pub key: Arc<str>,
    pub parent_key: Option<Arc<str>>,
    /// Stable hash of the record type and field path, from the original key spellings.
    #[serde(with = "hash::i64_string")]
    pub path_hash: i64,
}

impl Leaf {
    /// The value's text as stored in `nodes.value`. Strings are unchanged, numbers keep their
    /// source spelling and booleans are `true` or `false`. NUL characters are removed, because
    /// PostgreSQL text cannot hold them.
    #[must_use]
    pub fn value_text(&self) -> String {
        let text = match &self.value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        if text.contains('\0') {
            text.replace('\0', "")
        } else {
            text
        }
    }

    /// The hash of [`Leaf::value_text`], equal to `folio_h64(value)` in the generated SQL.
    #[must_use]
    pub fn value_hash(&self) -> i64 {
        hash::value_hash(&self.value_text())
    }
}

#[derive(Clone, Debug, Default)]
pub struct Mapper {
    config: Config,
}

impl Mapper {
    #[must_use]
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    pub fn map_json(&self, name: &str, input: &[u8]) -> serde_json::Result<Vec<Leaf>> {
        let value = serde_json::from_slice(input)?;
        Ok(self.map_value_with_seed(name, &value, input))
    }

    pub fn map_json_path(
        &self,
        name: &str,
        path: &str,
        input: &[u8],
    ) -> serde_json::Result<Vec<Leaf>> {
        let value: Value = serde_json::from_slice(input)?;
        let selected = path
            .split('.')
            .filter(|part| !part.is_empty())
            .try_fold(&value, |current, part| current.get(part))
            .unwrap_or(&Value::Null);
        Ok(self.map_value_with_seed(name, selected, input))
    }

    #[cfg(feature = "xml")]
    pub fn map_xml(&self, name: &str, input: &str) -> Result<Vec<Leaf>, quick_xml::de::DeError> {
        crate::xml::xml_to_leaves(&self.config, name, input)
    }

    #[must_use]
    pub fn map_value(&self, name: &str, value: &Value) -> Vec<Leaf> {
        let seed = serde_json::to_vec(value).unwrap_or_default();
        self.map_value_with_seed(name, value, &seed)
    }

    fn map_value_with_seed(&self, name: &str, value: &Value, seed: &[u8]) -> Vec<Leaf> {
        let mut state = MapState::new(&self.config, name, seed);
        let root = state.root_record(name);
        state.visit(name, "", &mut Vec::new(), root, value);
        state.leaves
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Record {
    pub(crate) id: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) name: String,
    key: RecordKey,
    key_hex: Arc<str>,
    parent_key_hex: Option<Arc<str>>,
    record_type: u32,
}

pub(crate) struct LeafBuilder<'a> {
    state: MapState<'a>,
    item_counts: HashMap<(RecordKey, String), u64>,
}

impl<'a> LeafBuilder<'a> {
    pub(crate) fn new(config: &'a Config, name: &str, seed: &[u8]) -> Self {
        Self {
            state: MapState::new(config, name, seed),
            item_counts: HashMap::new(),
        }
    }

    pub(crate) fn root(&mut self, name: &str) -> Record {
        let record = self.state.root_record(name);
        self.state.ensure_tree(&record, &record.name);
        record
    }

    pub(crate) fn child(&mut self, parent: &Record, path: &str) -> Record {
        let count = self
            .item_counts
            .entry((parent.key, path.to_owned()))
            .or_insert(0);
        let index = *count;
        *count += 1;
        let record = self.state.child_record(
            parent,
            format!("{}__{path}", parent.name),
            vec![Part::Key(path.to_owned())],
            Some(index),
        );
        self.state.ensure_tree(&record, &record.name);
        record
    }

    pub(crate) fn add_string(&mut self, record: &Record, path: &str, value: String) {
        self.state.add_leaf(
            &record.name,
            path,
            record.clone(),
            vec![Part::Key(path.to_owned())],
            Value::String(value),
        );
    }

    pub(crate) fn finish(self) -> Vec<Leaf> {
        self.state.leaves
    }
}

struct MapState<'a> {
    config: &'a Config,
    ids: IdFactory,
    leaves: Vec<Leaf>,
    tree_nodes: HashSet<String>,
    overrides: HashMap<(&'a str, &'a str), (&'a str, &'a str)>,
    record_types: Vec<Vec<Part>>,
    record_type_ids: HashMap<Vec<Part>, u32>,
    path_hashes: HashMap<(u32, Vec<Part>), i64>,
    stable_keys: bool,
}

impl<'a> MapState<'a> {
    fn new(config: &'a Config, name: &str, seed: &[u8]) -> Self {
        let overrides = config
            .column_overrides
            .iter()
            .map(|item| {
                (
                    (item.table.as_str(), item.path.as_str()),
                    (item.target_table.as_str(), item.target_path.as_str()),
                )
            })
            .collect();

        Self {
            config,
            ids: IdFactory::new(name, seed),
            leaves: Vec::new(),
            tree_nodes: HashSet::new(),
            overrides,
            record_types: Vec::new(),
            record_type_ids: HashMap::new(),
            path_hashes: HashMap::new(),
            stable_keys: !config.skip_stable_keys,
        }
    }

    fn record_type_id(&mut self, record_type: Vec<Part>) -> u32 {
        if let Some(id) = self.record_type_ids.get(&record_type) {
            return *id;
        }
        let id = u32::try_from(self.record_types.len()).unwrap_or(u32::MAX);
        self.record_types.push(record_type.clone());
        self.record_type_ids.insert(record_type, id);
        id
    }

    fn path_hash(&mut self, record_type: u32, field: Vec<Part>) -> i64 {
        if !self.stable_keys {
            return 0;
        }
        let cache_key = (record_type, field);
        if let Some(hash) = self.path_hashes.get(&cache_key) {
            return *hash;
        }
        let parts = &self.record_types[record_type as usize];
        let hash = hash::path_hash(parts, &cache_key.1);
        self.path_hashes.insert(cache_key, hash);
        hash
    }

    fn root_record(&mut self, name: &str) -> Record {
        let id = self.ids.next();
        if !self.stable_keys {
            return Record {
                id,
                parent_id: None,
                name: name.to_owned(),
                key: [0; 16],
                key_hex: Arc::from(""),
                parent_key_hex: None,
                record_type: 0,
            };
        }
        let steps = vec![Part::Source(name.to_owned())];
        let key = hash::record_key(None, &steps, None);
        Record {
            id,
            parent_id: None,
            name: name.to_owned(),
            key,
            key_hex: Arc::from(hash::key_hex(&key)),
            parent_key_hex: None,
            record_type: self.record_type_id(steps),
        }
    }

    fn child_record(
        &mut self,
        parent: &Record,
        name: String,
        steps: Vec<Part>,
        index: Option<u64>,
    ) -> Record {
        let id = self.ids.next();
        if !self.stable_keys {
            return Record {
                id,
                parent_id: Some(parent.id.clone()),
                name,
                key: [0; 16],
                key_hex: parent.key_hex.clone(),
                parent_key_hex: None,
                record_type: 0,
            };
        }
        let key = hash::record_key(Some(&parent.key), &steps, index);
        let parent_type = &self.record_types[parent.record_type as usize];
        let mut record_type = Vec::with_capacity(parent_type.len() + steps.len() + 1);
        record_type.extend_from_slice(parent_type);
        record_type.extend(steps);
        if index.is_some() {
            record_type.push(Part::Items);
        }
        Record {
            id,
            parent_id: Some(parent.id.clone()),
            name,
            key,
            key_hex: Arc::from(hash::key_hex(&key)),
            parent_key_hex: Some(parent.key_hex.clone()),
            record_type: self.record_type_id(record_type),
        }
    }

    fn visit(
        &mut self,
        name: &str,
        path: &str,
        segments: &mut Vec<String>,
        mut record: Record,
        value: &Value,
    ) {
        if value.is_null() {
            return;
        }

        let mut name = name.to_owned();
        let mut path = path.to_owned();
        let mut promoted_segments = Vec::new();
        let mut segments = segments;

        if self.config.table_names.iter().any(|item| item == &path) {
            name = path;
            path = String::new();
            let mut steps = key_parts(segments);
            steps.push(Part::Table);
            record = self.child_record(&record, name.clone(), steps, None);
            segments = &mut promoted_segments;
        }

        self.ensure_tree(&record, &name);

        match value {
            Value::Bool(_) | Value::Number(_) | Value::String(_) => {
                let field = if segments.is_empty() {
                    vec![Part::ScalarItem]
                } else {
                    key_parts(segments)
                };
                if path.is_empty() {
                    path = "value".to_owned();
                }
                self.add_leaf(&name, &path, record, field, value.clone());
            }
            Value::Array(items) => {
                if !path.is_empty() && !name.is_empty() {
                    name = format!("{name}__{path}");
                }
                let steps = key_parts(segments);
                for (index, item) in items.iter().enumerate() {
                    let index = u64::try_from(index).unwrap_or(u64::MAX);
                    let child =
                        self.child_record(&record, name.clone(), steps.clone(), Some(index));
                    self.visit(&name, "", &mut Vec::new(), child, item);
                }
            }
            Value::Object(items) => {
                for (key, item) in items {
                    let next_path = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}__{key}")
                    };
                    segments.push(key.clone());
                    self.visit(&name, &next_path, segments, record.clone(), item);
                    segments.pop();
                }
            }
            Value::Null => {}
        }
    }

    fn add_leaf(
        &mut self,
        name: &str,
        path: &str,
        mut record: Record,
        mut field: Vec<Part>,
        value: Value,
    ) {
        let mut name = apply_substitutions(to_snake_case(name), &self.config.table_substitutions);
        let mut path = apply_substitutions(to_snake_case(path), &self.config.column_substitutions);

        if let Some((target_table, target_path)) = self
            .overrides
            .get(&(name.as_str(), path.as_str()))
            .map(|(table, path)| ((*table).to_owned(), (*path).to_owned()))
        {
            let steps = vec![
                Part::Override(target_table.clone()),
                Part::Key(target_path.clone()),
            ];
            record = self.child_record(&record, target_table.clone(), steps, None);
            field = vec![Part::Key(target_path.clone())];
            name = target_table;
            path = target_path;
        }

        let data_type = match value {
            Value::Bool(_) => DataType::Boolean,
            Value::Number(_) => DataType::Number,
            Value::String(_) => DataType::String,
            _ => unreachable!("scalar values become leaves"),
        };

        let path_hash = self.path_hash(record.record_type, field);
        self.leaves.push(Leaf {
            data_type,
            name: name.clone(),
            id: record.id.clone(),
            parent_id: record.parent_id.clone(),
            path,
            value,
            key: record.key_hex.clone(),
            parent_key: record.parent_key_hex.clone(),
            path_hash,
        });

        self.ensure_tree(&record, &name);
    }

    fn ensure_tree(&mut self, record: &Record, name: &str) {
        if self.tree_nodes.insert(record.id.clone()) {
            let path_hash = self.path_hash(record.record_type, vec![Part::Tree]);
            self.leaves.push(Leaf {
                data_type: DataType::String,
                name: "_tree".to_owned(),
                id: record.id.clone(),
                parent_id: record.parent_id.clone(),
                path: "name".to_owned(),
                value: Value::String(to_snake_case(name)),
                key: record.key_hex.clone(),
                parent_key: record.parent_key_hex.clone(),
                path_hash,
            });
        }
    }
}

fn key_parts(segments: &[String]) -> Vec<Part> {
    segments.iter().cloned().map(Part::Key).collect()
}

struct IdFactory {
    prefix: String,
    next: u64,
}

impl IdFactory {
    fn new(name: &str, seed: &[u8]) -> Self {
        let mut digest = Sha256::new();
        digest.update(name.as_bytes());
        digest.update([0]);
        digest.update(seed);
        let hash = digest.finalize();
        let prefix = hash[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Self { prefix, next: 0 }
    }

    fn next(&mut self) -> String {
        let id = format!("{}-{:x}", self.prefix, self.next);
        self.next += 1;
        id
    }
}

fn apply_substitutions(mut value: String, substitutions: &[Substitution]) -> String {
    for substitution in substitutions {
        value = value.replace(&substitution.from, &substitution.to);
    }
    value
}

fn to_snake_case(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let chars: Vec<char> = value.chars().collect();

    for (index, character) in chars.iter().copied().enumerate() {
        if matches!(character, '-' | '#') {
            continue;
        }

        let previous = index
            .checked_sub(1)
            .and_then(|item| chars.get(item))
            .copied();
        let next = chars.get(index + 1).copied();
        let boundary = character.is_uppercase()
            && previous.is_some_and(|item| item.is_lowercase() || item.is_ascii_digit())
            || character.is_uppercase()
                && previous.is_some_and(|item| item.is_uppercase())
                && next.is_some_and(char::is_lowercase);

        if boundary && !output.ends_with('_') {
            output.push('_');
        }
        for lower in character.to_lowercase() {
            output.push(lower);
        }
    }

    while output.contains("___") {
        output = output.replace("___", "__");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_case_preserves_double_underscore_paths() {
        assert_eq!(to_snake_case("ObjectA__SubObject"), "object_a__sub_object");
        assert_eq!(to_snake_case("HTTPResult"), "http_result");
    }
}
