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

The PostgreSQL output adds four columns:

```sql
nodes(id, parent_id, name, path, data_type, value, key, parent_key, path_hash, value_hash)
```

`key` and `parent_key` are stable 128-bit record keys.
They depend on the source name and each record's place in the document's structure, so editing values does not change them.
`id` and `parent_id` number the records within one mapping and change with any edit.
`path_hash` identifies a field from its original key spellings, and `value_hash` is a 64-bit hash of the value's exact text.
See [`docs/hashing.md`](docs/hashing.md) for the definitions.

Values are stored exactly as written: numbers keep every source digit, and XML entity and character references are resolved.

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

The PostgreSQL output creates the same indexes on the stable keys, plus one for exact values:

- `(name, key)` and `(parent_key)` for records and traversal.
- `(name, path)` for fields.
- `(path_hash, value_hash)` for exact matches on values of any length.

Find an exact value through the hash index and compare the value too:

```sql
SELECT key FROM nodes
WHERE path_hash = $1
  AND value_hash = folio_h64('Smith & Sons Ltd')
  AND value = 'Smith & Sons Ltd';
```

PostgreSQL chooses an execution plan for each query.
[`docs/hosted-postgres.md`](docs/hosted-postgres.md) records measurements of these rows at scale.

### CSV input

The first row contains unique, nonempty column names.
Each data row must contain one cell for each column.
Cell values remain strings to preserve leading zeros and large identifiers.

CSV import supports quoted commas, escaped quotes, multiline cells, and UTF-8 files with a byte order mark.
Folio ignores empty lines outside quoted cells.

## Performance in PostgreSQL

json2Leaf rows were benchmarked in PostgreSQL 18 against two JSONB layouts and a typed table holding the same data.
The same 42 million records (a 2M-row table, a 20M-row table and 200 tenants with 100k rows each) were loaded into every layout and queried in one run.
Times are warm medians.

| Query, 20M-row table | Best-practice JSONB | json2Leaf rows | Typed table | Winner |
| --- | --- | --- | --- | --- |
| Sort on any field, top 100 | 2.25 s | **14 ms** | 0.94 s | json2Leaf, 160× |
| Count distinct | 17.9 s | **2.9 s** | 8.1 s | json2Leaf, 6× |
| Search all of a tenant's datasets | 0.93 s | **0.13 s** | 0.47 s | json2Leaf, 7× |
| Filter on an unindexed field | 1.87 s | **1.05 s** | 1.31 s | json2Leaf |
| Update one value | 1.7 ms | **1.4 ms** | 5.0 ms | json2Leaf, half the WAL |
| Group-by over all 20M rows | 17.3 s | 14.5 s | **1.16 s** | Typed, 12× |
| Join 2M rows to 20M rows | 8.7 s | 10.2 s | **3.5 s** | Typed |
| Three-way join, top 100 | 21.6 s | 181 s | **12 ms** | Typed |
| Filter on an indexed field | 84 ms | 357 ms | **41 ms** | Typed |
| Size, and full load with indexes | 20.7 GB, 41 min | 67.7 GB, 101 min | **8.2 GB, 14 min** | Typed |

Best-practice JSONB here means one row per record, typed values under short keys, a partition per dataset, expression and GIN indexes on the expected fields, and extended statistics.
It is never the fastest option.
json2Leaf rows win everything that looks for something: any field, any dataset, single-value writes.
A typed table wins everything that reads a whole large dataset.
For hosted use, store every document as json2Leaf rows and add a typed table per large record type.

Against a plain per-row JSONB layout (one row per record, values keyed by column id, a GIN index) on a 2M-row table, json2Leaf rows were 11 to 290 times faster:

| Query, 2M-row table | Per-row JSONB | json2Leaf rows | Faster |
| --- | --- | --- | --- |
| Sort on any field, top 100 | 6.1 s | 21 ms | 290× |
| Count distinct | 13.6 s | 0.20 s | 68× |
| Update one value | 83 ms | 1.9 ms | 44× |
| Group-by over all rows | 18.5 s | 0.47 s | 39× |
| Category and date filter | 1.25 s | 38 ms | 33× |
| Three-way join, top 100 | 7.8 s | 0.35 s | 22× |
| Upsert 5,000 rows | 17.4 s | 0.82 s | 21× |
| Join to a second dataset | 6.9 s | 0.62 s | 11× |

How the rows are stored matters.
Rows ordered by field, or partitioned by field type, keep one field's values together; on 2M rows that took a group-by from 6.2 s (rows ordered by record) to 0.47 s, and a join between datasets from 26 s to 0.62 s.
The single-table `nodes` layout with text values is the exchange and browser format, not a store for large data.

[`docs/hosted-postgres.md`](docs/hosted-postgres.md) has the setup, the full results, trees, indexes and the mapping issues found across nine document types.

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
Set `skip_stable_keys` in the configuration to leave `key`, `parent_key` and `path_hash` empty when you do not need them.
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
The Rust implementation adds XML, WebAssembly, stable record keys, and PostgreSQL output.
Folio provides the browser workspace for this model.

[SQLite `json_tree()`](https://www.sqlite.org/json1.html#jtree) and [DuckDB `json_tree()`](https://duckdb.org/docs/stable/data/json/json_functions) provide related document-to-row models.
[Snowflake `FLATTEN`](https://docs.snowflake.com/en/sql-reference/functions/flatten) exposes compound values as relational rows.
Folio combines materialized rows, stable record keys, cross-format parent relationships, and a browser reporting workflow.

## Current scope

Folio supports document analysis and reporting.
The mapper supports JSON objects, arrays, strings, numbers, Booleans, and null values.
The mapper represents each null value as an empty leaf set.

The current row model supports recursive traversal of mapped records.
Exact document reconstruction requires source key spelling, array indexes, empty container types, and XML mixed-content order.
See [`TODO.md`](TODO.md) for the planned round-trip model and query enhancements.

The command-line program reads JSON and XML files.
The browser bindings accept JSON and XML input.
