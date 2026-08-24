# json2Leaf

json2Leaf maps nested JSON and XML documents to leaf rows with explicit tree links.

Use the rows for PostgreSQL analysis, schema diagrams, or a custom data pipeline.
Stable document-based identifiers make repeated output easy to compare.

## History

Jamie Brough first wrote json2Leaf in Go in 2019.
The implementation came from his original idea for making nested documents relational and easy to query.

The current Rust implementation keeps this model and adds XML, WebAssembly, stable identifiers, and PostgreSQL output.

## Document model

json2Leaf maps scalar values to leaf rows and records the document hierarchy in `_tree` rows.
Each row has a stable `id` and an optional `parent_id`.
These links support recursive PostgreSQL queries across records at any depth.

The same model accepts JSON values, XML elements, XML attributes, and XML text.
Folio also infers record groups from physical nesting and presents them as queryable tables.

## Related work

[SQLite `json_tree()`](https://www.sqlite.org/json1.html#jtree) is the closest established model.
SQLite added it in version 3.9.0 in 2015.
It produces query-time rows with an element identifier, parent identifier, value, type, and path.

[DuckDB `json_tree()`](https://duckdb.org/docs/stable/data/json/json_functions) provides a similar recursive view of JSON.
[Snowflake `FLATTEN`](https://docs.snowflake.com/en/sql-reference/functions/flatten) converts compound values into relational rows.
[jsonschema2db](https://github.com/better/jsonschema2db) creates typed PostgreSQL tables from a supplied JSON Schema.
[json-flattener](https://github.com/cmungall/json-flattener) creates denormalized tables for data frames and spreadsheets.
[undatum](https://github.com/datenoio/undatum) converts, inspects, and queries many document formats, including JSON and XML.

json2Leaf combines several parts of this field in one library:

- It materializes document rows in ordinary PostgreSQL tables.
- It gives repeated mappings stable document-based identifiers.
- It uses one relational model for JSON and XML.
- It exposes XML attributes and text as queryable values.
- It retains parent links across inferred record groups.
- It runs as a Rust library, command-line tool, or WebAssembly module.

In technical terms, json2Leaf is a cross-format, materialized `json_tree` with stable relationships and inferred record groups.

## Command-line use

Install Rust 1.85 or a later version.

Generate a PostgreSQL import script:

```sh
cargo run -- ./my/reporting/dir
psql -U postgres -d mydb -f output.sql
```

Use `--sql-mode insert` for PostgreSQL single-user mode and pgrust Wasm.

Generate a Graphviz DOT diagram:

```sh
cargo run -- ./my/reporting/dir --format dot --output schema.dot
```

Print the mapped leaves as JSON:

```sh
cargo run -- report.json --format json
```

Use `--config config.json` to set table names, substitutions, and column overrides.
Use [`config.example.json`](config.example.json) as a configuration model.

## Library use

```rust
use json2leaf::{Config, Mapper};

let mapper = Mapper::new(Config::default());
let leaves = mapper.map_json("report", br#"{"items":[{"name":"one"}]}"#)?;
# Ok::<(), serde_json::Error>(())
```

The library makes stable identifiers from each source name and document.

## WebAssembly use

Check the browser-compatible library:

```sh
cargo check --target wasm32-unknown-unknown \
  --no-default-features --features wasm --lib
```

Build JavaScript bindings with `wasm-pack`:

```sh
wasm-pack build --target web --no-default-features --features wasm
```

The bindings export `mapJson`, `mapXml`, `jsonToSql`, `jsonToInsertSql`, `jsonToDot`, and `TrigramIndex`.
Each mapping function accepts a source name, a document string, and an optional configuration string.

## Folio

Folio is the browser studio for json2Leaf.
It turns each document into a traversable schema for reporting.

Build the browser bindings:

```sh
wasm-pack build --target web --out-dir web/pkg \
  --no-default-features --features wasm
```

Start the local web server from the repository root:

```sh
node scripts/serve-web.mjs
```

Open `http://localhost:8000/web/`.
Folio maps JSON and XML documents in the browser.
It infers tables and creates PostgreSQL for visual query plans.
The local preview lets you check each plan before you use its SQL.
Dedicated workers map documents, prepare table data, and search elements.
The trigram worker builds its postings when the first search starts.
It reuses the postings for each later search.
Use the 30 MB Discogs sample to explore releases, artists, labels, genres, styles, tracks, credits, and identifiers.
The initial report joins each release to its nested music records through `parent_id`.
It groups Electronic releases by artist and reports their tracks, labels, and styles.

## pgrust Wasm test

Build the pgrust Wasm module and its VFS assets.
Place the pgrust checkout next to this repository.

Run the integration test:

```sh
tests/pgrust-wasm.sh
```

The test loads generated SQL into pgrust Wasm.
It checks recursive traversal, typed values, aggregation, root values, and relationship joins.

## Folio deployment

Folio runs at `https://folio.wavey.ai` on the `folio-studio` Cloudflare Worker.
Large runtime files are public at `https://assets.folio.wavey.ai` in the `folio-public-assets` R2 bucket.

Provision the bucket, CORS policy, and asset domain:

```sh
node scripts/provision-cloudflare.mjs
```

Publish the content-addressed Wasm, PostgreSQL VFS, demo, and Qwen model:

```sh
node scripts/publish-cloudflare-assets.mjs
```

Build and deploy the app Worker:

```sh
node scripts/build-cloudflare.mjs
npx wrangler deploy
```

## Current scope

The mapper supports JSON objects, arrays, strings, numbers, Booleans, and null values.
The mapper represents each null value as an empty leaf set.

The current row model supports recursive traversal of mapped records.
Exact document reconstruction requires source key spelling, array indexes, empty container types, and XML mixed-content order.
See [`TODO.md`](TODO.md) for the planned round-trip model and query enhancements.

The command-line program reads JSON and XML files.
The browser bindings accept JSON and XML input.
