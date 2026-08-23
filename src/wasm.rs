use wasm_bindgen::prelude::*;

use crate::{
    Config, Graph, Mapper, TrigramIndex as RustTrigramIndex, leaves_to_insert_sql, leaves_to_sql,
    xml_to_json,
};

fn config(value: Option<String>) -> Result<Config, JsValue> {
    value.map_or_else(
        || Ok(Config::default()),
        |json| serde_json::from_str(&json).map_err(js_error),
    )
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub struct TrigramIndex {
    inner: RustTrigramIndex,
}

#[wasm_bindgen]
impl TrigramIndex {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: RustTrigramIndex::new(),
        }
    }

    pub fn add(&mut self, id: &str, text: &str) {
        self.inner.add(id, text);
    }

    pub fn search(&mut self, query: &str, limit: usize) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.search(query, limit)).map_err(js_error)
    }
}

impl Default for TrigramIndex {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen(js_name = mapJson)]
pub fn map_json(name: &str, input: &str, config_json: Option<String>) -> Result<String, JsValue> {
    let leaves = Mapper::new(config(config_json)?)
        .map_json(name, input.as_bytes())
        .map_err(js_error)?;
    serde_json::to_string(&leaves).map_err(js_error)
}

#[wasm_bindgen(js_name = mapXml)]
pub fn map_xml(name: &str, input: &str, config_json: Option<String>) -> Result<String, JsValue> {
    let value = xml_to_json(input).map_err(js_error)?;
    let leaves = Mapper::new(config(config_json)?).map_value(name, &value);
    serde_json::to_string(&leaves).map_err(js_error)
}

#[wasm_bindgen(js_name = jsonToSql)]
pub fn json_to_sql(
    name: &str,
    input: &str,
    config_json: Option<String>,
) -> Result<String, JsValue> {
    let leaves = Mapper::new(config(config_json)?)
        .map_json(name, input.as_bytes())
        .map_err(js_error)?;
    leaves_to_sql([leaves.as_slice()]).map_err(js_error)
}

#[wasm_bindgen(js_name = jsonToInsertSql)]
pub fn json_to_insert_sql(
    name: &str,
    input: &str,
    config_json: Option<String>,
) -> Result<String, JsValue> {
    let leaves = Mapper::new(config(config_json)?)
        .map_json(name, input.as_bytes())
        .map_err(js_error)?;
    leaves_to_insert_sql([leaves.as_slice()]).map_err(js_error)
}

#[wasm_bindgen(js_name = jsonToDot)]
pub fn json_to_dot(
    name: &str,
    input: &str,
    config_json: Option<String>,
) -> Result<String, JsValue> {
    let leaves = Mapper::new(config(config_json)?)
        .map_json(name, input.as_bytes())
        .map_err(js_error)?;
    let mut graph = Graph::new("schema");
    graph.add_subgraph(name, &leaves);
    Ok(graph.to_dot())
}
