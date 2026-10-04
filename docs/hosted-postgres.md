# json2Leaf rows in a hosted PostgreSQL database

These findings come from running json2Leaf output at scale in PostgreSQL, outside the browser, in October 2026.
They compare three layouts: the `nodes` table as json2Leaf writes it, typed and indexed leaf rows, and typed tables generated per inferred record type.

In short:

- The model works for every document shape tested: records, parent links and a catalog of inferred tables and fields answered every question, including joins across documents.
- The `nodes` table as written is a good exchange and browser format, but a slow store: 3 to 240 times slower than typed tables, and the largest.
- Typed, indexed leaf rows are fast for selective lookups on any field with no per-field index, and for traversal. They are 4 to 15 times slower than typed tables on whole-table aggregates and wide joins, and about 11 times larger.
- Typed tables generated per inferred record type are the fastest query surface and the easiest SQL to write.
- Several mapping issues silently changed or dropped data. The XML entity loss, the `__` path ambiguity in hashes, number rounding and record identity are fixed; the rest are listed below.

## Setup

PostgreSQL 18 on a 16 vCPU, 123 GB Linux machine shared with other work, with per-session settings of 256 MB `work_mem` and 6 parallel workers.
Timings are medians of five warm runs; reads came mostly from the operating system's page cache.
A database on network storage with no such cache would favour the smaller layouts further.

The layouts:

| Layout | Rows | Values |
| --- | --- | --- |
| `nodes` as written | One per value, plus a `_tree` row per record | Text, with `name` and `path` text on every row |
| Typed leaf rows | One per value, partitioned per dataset | Typed columns (`v_text`, `v_num`, `v_ts`, `v_bool`), a small field id, a covering index per type on `(dataset, field, value, record)` |
| Typed tables | One per record, one table per inferred record type | Real typed columns, indexes added per field as needed |

## A 2 million row table

A generated table of 2,000,000 rows and 30 fields (text, numbers, dates, Booleans and three mostly empty fields), with a second dataset of 500,000 rows in the same tables and a three-level hierarchy of 2.45 million records.

| | Typed leaf rows | Typed tables |
| --- | --- | --- |
| Size, with indexes | 8.4 GB (4.35 KB per record) | 0.78 GB (391 B per record) |
| Load: COPY, index build | 366 s | 24 s |
| WAL written by the load | 11.0 GB | 1.34 GB |

The `nodes` table as written took 7.6 minutes to COPY and 3.5 more to build Folio's three indexes, and used 9.5 GB.

| Query | Typed leaf rows | Typed tables |
| --- | --- | --- |
| First page, keyset page at row 1,000,000 | 4 ms | 0.9 ms |
| Sort on a number, top 100 | 3.3 ms | 1 ms with an index, 0.22 s without |
| Filter on a category and a date range | 39 ms | 22 ms |
| Group by a category over all rows | 3.9 s | 0.23 s |
| Count distinct values of a field | 0.35 s | 3.2 s |
| Join to the second dataset, filter and aggregate | 5.2 s | 0.35 s |
| Roll the table up through the hierarchy | 3.5 s | 0.55 s |
| Three-way join with filters on each side, top 100 | 0.35 s | 0.23 s |
| Upsert 5,000 records, three fields each | 2.7 s | 5.2 s |
| Update one value | 13 ms | 18 ms |
| Add a field and fill it for every record | over 300 s | 231 s |

The page, filter and write queries ran with default PostgreSQL settings; the others with the per-session settings above.

Leaf rows win where every field needs an index and only a few rows match: the covering indexes make any filter, sort or distinct on any field an index scan.
They lose where a query reads many fields of many records, because each record's values sit in about 30 separate index entries.
The cost per row is mostly PostgreSQL's fixed tuple and index overhead, so encoding names or paths more compactly saves little.

On 100,000 rows of 20 fields, the `nodes` table as written used 293 MB against 22 MB typed.
A filter took 967 ms (143 to 239 ms written as a semi-join) against 14.5 ms, and a group-by 200 ms against 33 ms.

## Nine document shapes

Ten generated datasets (about 359 MB) covering nine shapes, sharing property, unit and lease identifiers so they could be joined.
Sizes include indexes; query times are a typical question per shape.

| Shape | Size: `nodes` / leaf rows / typed (MB) | Query: leaf rows / typed (ms) |
| --- | --- | --- |
| CSV with mixed types, 200,000 rows | 479 / 456 / 54 | 101 / 29 |
| Spreadsheet, three linked sheets | 131 / 98 / 18 | 108 / 12 |
| Nested CRM export (accounts, opportunities, line items) | 119 / 72 / 12 | 38 / 3 |
| Sparse events, 589 distinct keys | 711 / 501 / 132 | 2 / 39 (filter on a rare key) |
| XML (the Discogs sample) | – | 177 / 17 (`nodes`: 4,108) |
| Arrays and time series | 615 / 338 / 146 | 75 / 11 |
| Document extraction output, 50,000 documents | 2,477 / 1,618 / 468 | 461 / 63 |
| Columnar export with decimals, dates and nested columns | 862 / 648 / 136 | 109 / 14 |
| GeoJSON parcels | 458 / 226 / 109 | 3,144 / 1,527 (needs a geometry column) |

Joins across documents returned the same rows in every layout:

| Join | Leaf rows (ms) | Typed (ms) |
| --- | --- | --- |
| Extracted fields to spreadsheet rows, by lease | 840 | 265 |
| CRM opportunities to spreadsheet properties | 139 | 6 |
| XML listings to spreadsheet units | 201 | 34 |
| Columnar financials to CSV comparables | 298 | 95 |
| GeoJSON parcels to properties, by parcel number | 85 | 4 |

The friction in joins was identifier formats, not layout: a spreadsheet stored a property id as the number `731` where every other source had the text `000731`.

## Indexes

PostgreSQL B-tree entries are limited to about 2,700 bytes.
An index on `(name, path, value)` failed on the Discogs sample, whose longest value is 4,781 bytes.
Prefix indexes (`left(value, 256)`) work, but every query has to repeat the expression to use them.

The `(path_hash, value_hash)` index from [`hashing.md`](hashing.md) has no length limit.
On the Discogs sample (1.05 million rows, 256,000 records) it is 14 MB, and the whole load with four indexes took 11.3 s:

| Query | Time |
| --- | --- |
| Exact match on a 4,781-byte value, through the hash index | 0.14 ms |
| Exact match on a short value, through the hash index | 0.07 ms |
| The same match scanning one field's values | 22 ms |
| All 116 records under one release, recursive over `parent_key` | 0.94 ms |

Generic typed value indexes have a trap: they only cover rows that hold that type, so a query must include `v_text IS NOT NULL` (or the equivalent) to use them.
Without it one query scanned everything: 2,140 ms against 70 ms.

## Traversal

The indexes that serve traversal and reassembly hold only identifiers: `(parent_key)`, `(name, key)` and the record key itself.
They never meet the length limit, and stay small.

On the 2.45 million record hierarchy:

| Query | Time |
| --- | --- |
| One record's subtree, or one record's ancestors | about 1 ms in every layout |
| Total of a field per top-level record, `WITH RECURSIVE` over parent links | 5.5 s |
| The same, through an array of ancestor keys stored on each record | 0.7 s |
| The same, through typed tables joined level by level | 0.62 s |

Point traversal is cheap however the tree is stored.
Roll-ups over a whole tree want an ancestors array or a closure table.

Rebuilding documents in SQL from leaf rows can mislead the planner: one read of 20 small documents took 1,137 ms with the default plan and 7.1 ms with nested loops.
Rebuilding them in the application from an index range scan avoids the problem.

## Mapping issues

Found by mapping the nine shapes and checking the rows against the sources.

| Issue | Effect | Status |
| --- | --- | --- |
| XML entity and character references dropped | `Dom &amp; Roland` became `Dom Roland` in 63% of Discogs releases; `&#13;` disappeared | Fixed: references are resolved, unknown entities kept as written |
| `__` used both as the path separator and in keys | A CRM field `Property__c` read as nesting; 3% of accounts could be rebuilt | Fixed in `path_hash`, which hashes original key segments; `path` text is unchanged |
| Key spellings that normalise to the same name | `ZIP` and `Zip`, or `postCode` and `post_code`, share one `path`; 60% of ZIP codes were lost when pivoted | Distinct `path_hash` values; `path` text still collides |
| Numbers rounded through floating point | Last-digit changes in 32% of rows of one export | Fixed: numbers keep every source digit (exponents are written with a sign, `1e+3`) |
| Record ids change with any edit | No identity for updates or comparisons | Fixed: stable `key` and `parent_key` |
| Nulls, empty objects and empty arrays dropped | A re-import cannot clear a value | Open |
| Array positions not stored | Matrix rows and coordinates told apart only by row order | Open; record keys encode the index |
| XML namespaces not resolved, mixed-content order lost | Two prefixes for one namespace become two field sets | Open |
| Scalar arrays mapped as records | One record per bounding-box number: 3.2 million of 4.05 million records in one dataset | Open |
| The command line names root tables after each file | 50,000 files give 50,000 table names | Open |
| Whole documents held in memory | About 25 to 28 times the input size | Open |
| `table_substitutions` not applied to `_tree` rows; column overrides split records | Broken traversal after renaming | Open |
| No spreadsheet, columnar or GeoJSON import | Header rows, merged headers, subtotal rows, formula values and source types need handling | Open |

Mapping ran at 4.6 to 17.4 MB/s, 0.43 to 0.90 million leaves per second per core.
Arrays and coordinates multiply rows: 15 MB of array JSON gave 2.97 million rows, 13.8 MB of GeoJSON 1.93 million.

## Writing SQL for an assistant

| Layout | Characters per query | Joins per query | Opaque ids per query |
| --- | --- | --- | --- |
| `nodes` as written | 539 | 2.6 | 0.3 |
| Typed leaf rows | 466 | 2.8 | 3.4 |
| Typed tables | 246 | 0.7 | 0.1 |

A catalog of inferred tables and fields, with each field's type, share of empty values, distinct count and most common values, was what made generated SQL correct.
Its most common values exposed formula text, placeholder tokens, mismatched identifier formats and empty fields before a query ran.
Schema questions answered from the catalog took 0.2 to 0.5 ms, against 80 to 150 ms scanning rows.
It still lacked each field's original key and source format, its role (identifier, measure, date, category), units, links between related fields, and suggested joins.

## Recommendation

For hosted use, keep the json2Leaf model, the stable keys and the catalog.
Generate typed tables (or views) per inferred record type as the query surface.
Keep typed leaf rows as an optional layer for rare keys and lookups on any field, and for history.
Keep the `nodes` table as the exchange and browser format.
