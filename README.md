# Folio

**Turn JSON, XML, and CSV into SQL reports in your browser.**

Explore relationships, ask questions, and export results—all locally.

Folio infers the structure, generates editable PostgreSQL, and runs your queries locally.
Use visual controls, write SQL, or ask the local assistant to write it for you.

[Open Folio](https://folio.wavey.ai) · [Example report](#example-report) · [Local development](#local-development)

## Document analysis

An API response can contain customers, orders, and line items at different depths.
An XML catalog can contain releases, artists, labels, and tracks.
Folio makes these nested records queryable while retaining their parent relationships.

You can inspect an unfamiliar export, compare records, calculate totals, and produce a CSV report in one workspace.
The generated SQL remains visible and editable throughout.

- **Automatic structure.** Open JSON, XML, or CSV and browse the inferred tables, fields, and record counts.
- **Relationships at every depth.** Use `WITH RECURSIVE` to follow ancestors and descendants through the document hierarchy.
- **Three query methods.** Build a report visually, edit PostgreSQL directly, or ask a question in natural language.
- **Local query execution.** Document mapping, SQL execution, and the optional assistant run in your browser.
- **Reusable work.** Save queries and report results on this device, copy SQL, and download results as CSV.
- **Searchable schema.** Find tables and fields through the schema search, including approximate name matches.

## First report

1. Open [folio.wavey.ai](https://folio.wavey.ai).
2. Drop a JSON, XML, or CSV file into the workspace, or load the demo dataset.
3. Explore the inferred tables and their fields.
4. Choose a report, write SQL, or ask Folio a question.
5. Run the query and inspect the result.
6. Save your query or download the report as CSV.

The visual builder and SQL editor work independently of the assistant.
You can begin querying while the optional model downloads.

## Example report

The included 30 MB Discogs XML sample contains releases, artists, labels, genres, styles, tracks, credits, and identifiers.
Its initial report answers:

> Which Electronic artists have at least three releases, and how many tracks and labels do those releases cover?

The report shows release counts, track counts, distinct labels, and styles for the top 25 artists.
It uses `WITH RECURSIVE` to follow each release's nested records through `parent_id`.
The query combines those records with fields stored directly on each release.

Load the demo to inspect the SQL, run the report, and change the question.

## Local analysis and AI

Folio processes imported documents on your device.
The Rust mapper runs through WebAssembly, and pgrust runs PostgreSQL queries in the browser.
Dedicated workers prepare records, search the schema, and execute queries.

The optional Qwen assistant also runs locally.
It uses the document schema to generate SQL; the SQL engine calculates the report rows and totals.
Local model downloads and response times depend on your device and browser.

The **Use your model** option prepares a prompt for another assistant.
That prompt includes schema details and selected example values.
You choose whether to copy it into an external service, then paste the returned SQL into Folio.

Saved queries, reports, and the current document use browser storage.
Download reports you need to retain independently of that browser.

## Document model

Folio uses json2Leaf, the Rust mapper included in this repository.
The mapper stores scalar values and structural links in one PostgreSQL table:

```sql
nodes(id, parent_id, name, path, data_type, value)
```

Rows with the same `name` and `id` form an inferred record.
The `parent_id` identifies its containing record.
Structural rows use `name = '_tree'`; their `value` contains the inferred table name.
Stable document-based identifiers make repeated mappings easy to compare.

The same model accepts JSON values, XML elements, XML attributes, and XML text.
XML attribute paths start with `@`, and element text uses `$text`.
Folio converts CSV rows into flat JSON objects before mapping them.

### Recursive SQL

This query follows the document from its roots through every mapped level:

```sql
WITH RECURSIVE tree AS (
    SELECT id, parent_id, value AS table_name, 0 AS depth
    FROM nodes
    WHERE name = '_tree' AND parent_id IS NULL
    UNION ALL
    SELECT child.id, child.parent_id, child.value, tree.depth + 1
    FROM tree
    JOIN nodes AS child ON child.parent_id = tree.id
    WHERE child.name = '_tree'
)
SELECT table_name, depth, id, parent_id
FROM tree
ORDER BY depth, table_name;
```

Traverse `_tree` rows first, then join scalar fields by `id`.
This keeps multiple fields on one record from multiplying traversal paths.
The Relationships starter reports ancestor and descendant types at each depth.
The examples below the web editor explain and demonstrate `WITH RECURSIVE`.

### Indexes

The browser database uses three PostgreSQL B-tree indexes:

- `(name, id)` for records within an inferred table.
- `(parent_id)` for child lookups.
- `(name, path)` for fields within an inferred table.

PostgreSQL chooses an execution plan for each query.

### CSV input

The first row contains unique, nonempty column names.
Each data row must contain one cell for each column.
Cell values remain strings to preserve leading zeros and large identifiers.

CSV import supports quoted commas, escaped quotes, multiline cells, and UTF-8 files with a byte order mark.
Folio ignores empty lines outside quoted cells.

## Local development

Install Rust 1.85 or later, Node.js, and `wasm-pack`.
Build the browser bindings from the repository root:

```sh
wasm-pack build --target web --out-dir web/pkg \
  --no-default-features --features wasm
```

Start the local server:

```sh
node scripts/serve-web.mjs
```

Open `http://localhost:8000/web/`.
The server supplies the cross-origin isolation headers required by the browser runtimes.
Runtime locations are defined in [`web/runtime-assets.js`](web/runtime-assets.js).

## Command-line tool

The `json2leaf` command reads JSON and XML files.
Use it to generate PostgreSQL imports, mapped rows, or Graphviz schema diagrams outside the browser.

Generate and load a PostgreSQL import script:

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
See [`config.example.json`](config.example.json) for the configuration format.

## Library use

The repository is named Folio; the Rust crate and command remain `json2leaf`.

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

## Tests

Run the web unit and integration tests:

```sh
npm --prefix web test
```

The integration tests execute queries in the bundled pgrust Wasm engine.
They cover schema starters, recursive relationships, aggregates, assistant query patterns, and the examples in the web page.
They also map the complete Discogs XML demo and compare its SQL report with the local preview.
These tests require the local Wasm files, PostgreSQL VFS assets, and Discogs sample under `web/`.

For the command-line PostgreSQL integration test, place the pgrust checkout beside this repository and build its Wasm and VFS assets.
Then run:

```sh
tests/pgrust-wasm.sh
```

The test loads generated SQL into pgrust Wasm.
It checks recursive traversal, typed values, aggregation, root values, and relationship joins.

## Deployment

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

## Origins and related work

Jamie Brough first wrote json2Leaf in Go in 2019 to make nested documents relational and easy to query.
The Rust implementation adds XML, WebAssembly, stable identifiers, and PostgreSQL output.
Folio provides the browser workspace for this model.

[SQLite `json_tree()`](https://www.sqlite.org/json1.html#jtree) and [DuckDB `json_tree()`](https://duckdb.org/docs/stable/data/json/json_functions) provide related document-to-row models.
[Snowflake `FLATTEN`](https://docs.snowflake.com/en/sql-reference/functions/flatten) exposes compound values as relational rows.
Folio combines materialized rows, stable identifiers, cross-format parent relationships, and a browser reporting workflow.

## Current scope

Folio supports document analysis and reporting.
The mapper supports JSON objects, arrays, strings, numbers, Booleans, and null values.
The mapper represents each null value as an empty leaf set.

The current row model supports recursive traversal of mapped records.
Exact document reconstruction requires source key spelling, array indexes, empty container types, and XML mixed-content order.
See [`TODO.md`](TODO.md) for the planned round-trip model and query enhancements.

The command-line program reads JSON and XML files.
The browser bindings accept JSON and XML input.
