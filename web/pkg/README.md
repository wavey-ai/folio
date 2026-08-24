# json2Leaf

json2Leaf maps nested JSON and XML documents to leaf rows with explicit tree links.

Use the rows for PostgreSQL analysis, schema diagrams, or a custom data pipeline.
Stable document-based identifiers make repeated output easy to compare.

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

Start a local web server from the repository root:

```sh
python3 -m http.server 8000
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

## Current scope

The mapper supports JSON objects, arrays, strings, numbers, Booleans, and null values.
The mapper represents each null value as an empty leaf set.

The command-line program reads JSON and XML files.
The browser bindings accept JSON and XML input.
