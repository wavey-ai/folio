# json2Leaf development tasks

This plan records enhancements found during the comparison with other document-to-row systems.

## Structural round trips

A structural round trip rebuilds the same JSON data model or XML information set from mapped rows.
It does not reproduce source whitespace or quotation choices.

- [ ] Define a versioned source-node schema for JSON and XML.
- [ ] Store each node kind: object, array, scalar, null, element, attribute, and text.
- [ ] Store the original key or qualified XML name separately from its normalized query name.
- [ ] Store each array index and each XML child position.
- [ ] Represent empty objects, empty arrays, and empty XML elements explicitly.
- [ ] Preserve XML namespace names and mixed-content order.
- [ ] Give repeated and singleton XML elements the same record shape across one document.
- [ ] Keep the source format, document identifier, root identifier, and schema version with each import.
- [ ] Add Rust functions that rebuild JSON and XML from source-node rows.
- [ ] Export the reconstruction functions through the command-line and WebAssembly interfaces.

## Query compatibility

- [ ] Keep the current `Leaf` API while the source-node schema is introduced.
- [ ] Derive the current `nodes` table from the source-node representation.
- [ ] Keep normalized table names and paths as query metadata.
- [ ] Add indexes for document, `id`, `parent_id`, name, path, and child position.
- [ ] Add reusable PostgreSQL queries for ancestors, descendants, siblings, and document paths.
- [ ] Evaluate a view that follows the SQLite `json_tree()` column model.
- [ ] Benchmark materialized queries against SQLite and DuckDB `json_tree()` queries.

## Verification

- [ ] Add JSON round-trip tests for nulls, empty containers, mixed arrays, Unicode, and original key spelling.
- [ ] Add property tests that compare input JSON with reconstructed JSON.
- [ ] Add XML round-trip tests for namespaces, attributes, repeated elements, and interleaved mixed content.
- [ ] Compare reconstructed XML with the input through canonical XML rules.
- [ ] Test recursive queries before and after the schema change.
- [ ] Test existing Folio reports against the compatibility view.
- [ ] Measure row count, memory use, import time, and query time in WebAssembly.

## Documentation

- [ ] Document the source-node schema and each stored node kind.
- [ ] Explain structural round trips and source-text reproduction as separate capabilities.
- [ ] Publish recursive PostgreSQL examples for JSON and XML documents.
- [ ] Add a comparison table for `json_tree()`, `FLATTEN`, schema-driven loaders, and json2Leaf.
