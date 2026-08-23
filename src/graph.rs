use std::collections::{BTreeMap, HashMap};

use crate::Leaf;

#[derive(Clone, Debug)]
pub struct Graph {
    name: String,
    subgraphs: Vec<Subgraph>,
}

#[derive(Clone, Debug)]
struct Subgraph {
    name: String,
    leaves: Vec<Leaf>,
}

impl Graph {
    #[must_use]
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            subgraphs: Vec::new(),
        }
    }

    pub fn add_subgraph(&mut self, name: impl Into<String>, leaves: &[Leaf]) {
        self.subgraphs.push(Subgraph {
            name: name.into(),
            leaves: leaves.to_vec(),
        });
    }

    #[must_use]
    pub fn to_dot(&self) -> String {
        let mut output = format!("digraph {} {{\n", dot_id(&self.name));
        output.push_str("  rankdir=LR;\n  node [shape=record];\n");

        for subgraph in &self.subgraphs {
            let nodes = nodes(&subgraph.leaves);
            output.push_str(&format!(
                "  subgraph cluster_{} {{\n",
                dot_id(&subgraph.name)
            ));
            output.push_str(&format!("    label={};\n", dot_string(&subgraph.name)));

            for node in nodes.values() {
                output.push_str(&format!(
                    "    {} [label={}];\n",
                    dot_id(&node.name),
                    dot_string(&node.label())
                ));
            }
            output.push_str("  }\n");

            for node in nodes.values() {
                if let Some(parent) = &node.parent {
                    output.push_str(&format!(
                        "  {} -> {};\n",
                        dot_id(parent),
                        dot_id(&node.name)
                    ));
                }
            }
        }
        output.push_str("}\n");
        output
    }
}

#[derive(Clone, Debug)]
struct Node {
    name: String,
    parent: Option<String>,
    attributes: BTreeMap<String, String>,
}

impl Node {
    fn label(&self) -> String {
        let leaf_name = self.name.rsplit("__").next().unwrap_or(&self.name);
        let attributes = self
            .attributes
            .iter()
            .map(|(path, data_type)| format!("+ {path} : {data_type}\\l"))
            .collect::<String>();
        format!("{{{leaf_name}|{attributes}}}")
    }
}

fn nodes(leaves: &[Leaf]) -> BTreeMap<String, Node> {
    let names: HashMap<&str, &str> = leaves
        .iter()
        .filter_map(|leaf| {
            if leaf.name == "_tree" {
                leaf.value.as_str().map(|name| (leaf.id.as_str(), name))
            } else {
                None
            }
        })
        .collect();

    let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
    for leaf in leaves.iter().filter(|leaf| leaf.name != "_tree") {
        let parent = leaf
            .parent_id
            .as_deref()
            .and_then(|id| names.get(id))
            .map(|name| (*name).to_owned());
        let node = nodes.entry(leaf.name.clone()).or_insert_with(|| Node {
            name: leaf.name.clone(),
            parent,
            attributes: BTreeMap::new(),
        });
        node.attributes
            .insert(leaf.path.clone(), leaf.data_type.to_string());
    }
    nodes
}

fn dot_id(value: &str) -> String {
    dot_string(value)
}

fn dot_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
    )
}

#[cfg(test)]
mod tests {
    use crate::{Config, Mapper};

    use super::*;

    #[test]
    fn graph_contains_tables_and_edges() {
        let leaves = Mapper::new(Config::default())
            .map_json("report", br#"{"items":[{"title":"one"}]}"#)
            .unwrap();
        let mut graph = Graph::new("schema");
        graph.add_subgraph("report", &leaves);
        let dot = graph.to_dot();

        assert!(dot.contains("\"report__items\""));
        assert!(dot.contains("\"report\" -> \"report__items\""));
        assert!(dot.contains("+ title : string\\\\l"));
    }
}
