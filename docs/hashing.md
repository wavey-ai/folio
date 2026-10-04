# Stable keys and hashes

json2Leaf gives every row four values that do not depend on the order of mapping:
a record `key`, its `parent_key`, a `path_hash` for the field, and a `value_hash` for the value.
They let a hosted database update records in place, compare imports and find exact values through small indexes.

The `id` and `parent_id` columns are unchanged.
They number the records within one mapping and change whenever the document changes.
The browser transport still uses them.

## The hash function

Every hash is SHA-256, truncated.
SHA-256 gives the same result in Rust (native and WebAssembly), in browsers (WebCrypto) and in PostgreSQL, where `sha256()` is built in from version 11.
The mapper already depended on it, so no new dependency was needed.

Faster non-cryptographic hashes such as xxh3 or BLAKE3 were rejected because PostgreSQL cannot compute them without an extension.
PostgreSQL's `hashtextextended()` was rejected because its algorithm is internal and not available outside PostgreSQL.
Rust's `DefaultHasher` and seeded hashers such as `ahash` must never be used for stored values: their output can change between releases.

Hashing is not the bottleneck.
SHA-256 runs at about 210 ns per short value in software on aarch64, and in hardware on x86_64.
Mapping runs at 0.4 to 0.9 million leaves per second.

## Definitions

`h64(bytes)` is the first 8 bytes of SHA-256(bytes), read as a big-endian signed 64-bit integer.
That matches PostgreSQL's `BIGINT`.

| Value | Width | Input | Collisions |
| --- | --- | --- | --- |
| `value_hash` | 64 bits | The UTF-8 bytes of the value exactly as stored in `nodes.value`, with no tag | Harmless: every lookup also compares the value |
| `path_hash` | 64 bits | `folio:path:v1`, then the record type's steps, a zero byte, then the field's steps | About 1 in 37 million for a million distinct fields |
| `key` | 128 bits | `folio:rec:v1`, the parent key, the steps to the record and its array index | Negligible: about 1 in 10^20 for a billion records |

Values are hashed exactly as stored.
`000731`, `731` and `731.0` have different hashes.
The mapper does not trim, fold case or normalise Unicode.

Record keys are 128 bits because a key collision would silently merge two records.
At a billion records a 64-bit key would have about a 2.7% chance of at least one collision.

### Steps

A path is hashed as a list of steps, never as the joined `path` text.
The joined text cannot tell a key named `Property__c` from a key `Property` holding a key `c`, or `postCode` from `post_code`.

| Step | Encoding |
| --- | --- |
| Source name of a root record | byte 1, 4-byte big-endian length, UTF-8 bytes |
| Object key, in its original spelling (XML: the field path) | byte 2, length, bytes |
| Into the items of an array | byte 3 |
| Field promoted by `table_names` | byte 4 |
| Column override target table | byte 5, length, bytes |
| Scalar array item, stored under the path `value` | byte 6 |
| The `_tree` row of a record | byte 7 |

A record key hashes byte 0 for a root or byte 1 and the parent key for a child, then its steps, then byte 8 and the 8-byte big-endian array index when it is an array item.
A record type is the list of steps from the root record to the record, with byte 3 after each array.

### What changes a key

A record key depends on the source name and the record's position in the document's structure.
Editing values does not change any key.
Appending an array item keeps the earlier items' keys.
Inserting or removing an item before others shifts the index of those that follow, and so their keys.
A natural key per table would remove that limitation; see [`TODO.md`](../TODO.md).

## PostgreSQL

The SQL output defines a matching function:

```sql
CREATE OR REPLACE FUNCTION folio_h64(TEXT) RETURNS BIGINT
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT ('x' || encode(substr(sha256(convert_to($1, 'UTF8')), 1, 8), 'hex'))::bit(64)::bigint $$;
```

`convert_to` is marked stable in PostgreSQL, so the function is declared immutable explicitly.
That is safe while the database encoding is UTF-8.

An exact match through the hash index compares the value too:

```sql
SELECT key
FROM nodes
WHERE path_hash = $1
  AND value_hash = folio_h64('Smith & Sons Ltd')
  AND value = 'Smith & Sons Ltd';
```

PostgreSQL evaluates `folio_h64` with a constant argument once, at planning time.

### Test vectors

These were computed in PostgreSQL 18 and match `json2leaf::value_hash`:

| Text | `folio_h64` |
| --- | --- |
| `Smith & Sons Ltd` | 5301750890647567476 |
| `café` | -8858723660289998967 |
| `000731` | 2184166409188743760 |
| `731` | -986540773525597110 |
| `731.0` | 7249036988491400777 |

## JSON and WebAssembly

`path_hash` is serialized as a decimal string so JavaScript keeps every digit.
`key` and `parent_key` are 32 lowercase hex digits, which PostgreSQL accepts as `UUID`.

Set `skip_stable_keys` in the configuration to leave `key`, `parent_key` and `path_hash` empty.
The browser's compact transport sets it, because it does not carry them.

## Cost

Measured on a 31 MB XML file and a 67 MB JSON file:

| Output | Time | Peak memory |
| --- | --- | --- |
| Leaves as JSON, keys on | +26 to 29% | +27 to 32% |
| Leaves as JSON, keys skipped | +10 to 17% | +16 to 17% |
| PostgreSQL COPY script | +35 to 40% | +8 to 16% |

The SQL output is about twice as large because of the four new columns.
