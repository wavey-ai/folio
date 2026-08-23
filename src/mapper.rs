use std::collections::{HashMap, HashSet};
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

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
    pub id: String,
    pub parent_id: Option<String>,
    pub path: String,
    pub value: Value,
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

    #[must_use]
    pub fn map_value(&self, name: &str, value: &Value) -> Vec<Leaf> {
        let seed = serde_json::to_vec(value).unwrap_or_default();
        self.map_value_with_seed(name, value, &seed)
    }

    fn map_value_with_seed(&self, name: &str, value: &Value, seed: &[u8]) -> Vec<Leaf> {
        let mut state = MapState::new(&self.config, name, seed);
        let root = state.ids.next();
        state.visit(name, "", root, None, value);
        state.leaves
    }
}

struct MapState<'a> {
    config: &'a Config,
    ids: IdFactory,
    leaves: Vec<Leaf>,
    tree_nodes: HashSet<String>,
    overrides: HashMap<(&'a str, &'a str), (&'a str, &'a str)>,
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
        }
    }

    fn visit(
        &mut self,
        name: &str,
        path: &str,
        mut node: String,
        mut parent: Option<String>,
        value: &Value,
    ) {
        if value.is_null() {
            return;
        }

        let mut name = name.to_owned();
        let mut path = path.to_owned();

        if self.config.table_names.iter().any(|item| item == &path) {
            name = path;
            path = String::new();
            parent = Some(node);
            node = self.ids.next();
        }

        self.ensure_tree(&node, parent.as_deref(), &name);

        match value {
            Value::Bool(_) | Value::Number(_) | Value::String(_) => {
                if path.is_empty() {
                    path = "value".to_owned();
                }
                self.add_leaf(&name, &path, node, parent, value.clone());
            }
            Value::Array(items) => {
                if !path.is_empty() && !name.is_empty() {
                    name = format!("{name}__{path}");
                }
                for item in items {
                    let child = self.ids.next();
                    self.visit(&name, "", child, Some(node.clone()), item);
                }
            }
            Value::Object(items) => {
                for (key, item) in items {
                    let next_path = if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}__{key}")
                    };
                    self.visit(&name, &next_path, node.clone(), parent.clone(), item);
                }
            }
            Value::Null => {}
        }
    }

    fn add_leaf(
        &mut self,
        name: &str,
        path: &str,
        mut node: String,
        mut parent: Option<String>,
        value: Value,
    ) {
        let old_node = node.clone();
        let mut name = apply_substitutions(to_snake_case(name), &self.config.table_substitutions);
        let mut path = apply_substitutions(to_snake_case(path), &self.config.column_substitutions);

        if let Some((target_table, target_path)) = self
            .overrides
            .get(&(name.as_str(), path.as_str()))
            .map(|(table, path)| ((*table).to_owned(), (*path).to_owned()))
        {
            name = target_table;
            path = target_path;
            parent = Some(old_node);
            node = self.ids.next();
        }

        let data_type = match value {
            Value::Bool(_) => DataType::Boolean,
            Value::Number(_) => DataType::Number,
            Value::String(_) => DataType::String,
            _ => unreachable!("scalar values become leaves"),
        };

        self.leaves.push(Leaf {
            data_type,
            name: name.clone(),
            id: node.clone(),
            parent_id: parent.clone(),
            path,
            value,
        });

        self.ensure_tree(&node, parent.as_deref(), &name);
    }

    fn ensure_tree(&mut self, node: &str, parent: Option<&str>, name: &str) {
        if self.tree_nodes.insert(node.to_owned()) {
            self.leaves.push(Leaf {
                data_type: DataType::String,
                name: "_tree".to_owned(),
                id: node.to_owned(),
                parent_id: parent.map(str::to_owned),
                path: "name".to_owned(),
                value: Value::String(to_snake_case(name)),
            });
        }
    }
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
