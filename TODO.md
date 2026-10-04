# json2Leaf development tasks

This plan records enhancements found during the comparison with other document-to-row systems.

## Stable keys and exact values

See [`docs/hashing.md`](docs/hashing.md).

- [x] Give every record a stable 128-bit key and parent key that do not change when values change.
- [x] Hash each field from its original key segments, so `__` in keys and differently spelled keys stay distinct.
- [x] Hash each value's exact text, with a matching `folio_h64()` function in the PostgreSQL output.
- [x] Keep every digit of JSON numbers.
- [x] Resolve XML entity and character references instead of dropping them.
- [ ] Accept a natural key per table, so inserting an array item does not change the keys of later items.
- [ ] Store the original key spelling in the rows as well as in `path_hash`.

## Hosted databases

Findings are in [`docs/hosted-postgres.md`](docs/hosted-postgres.md).

- [ ] Generate typed tables or views per inferred record type from the mapped rows.
- [ ] Publish a catalog: field type, share of empty values, distinct count, common values, original key, role, units and suggested joins.
- [ ] Map arrays of scalars and small tuples (tags, bounding boxes, coordinates) as array fields instead of records.
- [ ] Stream mapping instead of holding whole documents and their leaves in memory.
- [ ] Name root tables per source, not per file, when the command line maps many files.
- [ ] Add importers for spreadsheets (header rows, merged headers, subtotal rows, cached formula values), columnar files with their source types, GeoJSON geometry and JSON Lines.
- [ ] Store an ancestors array or closure table for roll-ups over whole trees.
- [ ] Apply `table_substitutions` to `_tree` rows, and keep overridden columns in one record.

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
