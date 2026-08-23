use std::collections::HashMap;

use serde_json::Value;

use crate::Leaf;

#[derive(Clone, Debug, Default)]
pub struct Replacer {
    replacements: HashMap<String, String>,
}

impl Replacer {
    #[must_use]
    pub fn new(replacements: impl IntoIterator<Item = (String, String)>) -> Self {
        Self {
            replacements: replacements
                .into_iter()
                .map(|(source, target)| (source.to_lowercase(), target))
                .collect(),
        }
    }

    #[must_use]
    pub fn replace(&self, leaves: &[Leaf]) -> Vec<Leaf> {
        leaves
            .iter()
            .cloned()
            .map(|mut leaf| {
                leaf.name = self.get(&leaf.name);
                leaf.path = self.get(&leaf.path);
                if let Value::String(value) = &leaf.value {
                    leaf.value = Value::String(self.get(value));
                }
                leaf
            })
            .collect()
    }

    fn get(&self, value: &str) -> String {
        self.replacements
            .get(&value.to_lowercase())
            .cloned()
            .unwrap_or_else(|| value.to_owned())
    }
}
