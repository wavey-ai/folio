#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PGRUST_ROOT=${PGRUST_ROOT:-"$ROOT/../pgrust"}
PGRUST_ASSETS=${PGRUST_ASSETS:-"$PGRUST_ROOT/wasm/assets"}

[[ -f "$PGRUST_ASSETS/postgres.wasm" ]] || {
    echo "missing pgrust Wasm module: $PGRUST_ASSETS/postgres.wasm" >&2
    exit 2
}
[[ -f "$PGRUST_ASSETS/vfs.img" ]] || {
    echo "missing pgrust VFS image: $PGRUST_ASSETS/vfs.img" >&2
    exit 2
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cargo run --quiet --manifest-path "$ROOT/Cargo.toml" -- \
    "$ROOT/tests/pgrust-fixtures" \
    --format sql \
    --sql-mode insert \
    --output "$WORK/load.sql"

PGRUST_WASM="$PGRUST_ASSETS/postgres.wasm" \
PGRUST_VFS="$PGRUST_ASSETS/vfs" \
node "$PGRUST_ROOT/wasm/run-node.mjs" --raw \
    < <(cat "$WORK/load.sql" "$ROOT/tests/pgrust-queries.sql") \
    > "$WORK/result.out" 2> "$WORK/result.err"

grep -q 'JSON2LEAF_TREE_OK' "$WORK/result.out"
grep -q 'JSON2LEAF_ROWS_OK' "$WORK/result.out"
grep -q 'JSON2LEAF_ROOT_OK' "$WORK/result.out"
grep -q 'JSON2LEAF_RELATIONSHIP_OK' "$WORK/result.out"

echo "json2Leaf pgrust Wasm queries passed."
