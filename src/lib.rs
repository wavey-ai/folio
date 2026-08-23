//! Convert nested documents into flat leaf rows with explicit tree links.

mod graph;
mod mapper;
mod redactor;
mod replacer;
mod sql;

#[cfg(feature = "xml")]
mod xml;

#[cfg(all(target_arch = "wasm32", feature = "wasm"))]
mod wasm;

pub use graph::Graph;
pub use mapper::{ColumnOverride, Config, DataType, Leaf, Mapper, Substitution};
pub use redactor::redact;
pub use replacer::Replacer;
pub use sql::{InsertSqlWriter, SqlWriter, leaves_to_insert_sql, leaves_to_sql};

#[cfg(feature = "xml")]
pub use xml::xml_to_json;
