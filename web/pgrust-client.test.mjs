import assert from "node:assert/strict";
import test from "node:test";

import { resultFromWorker } from "./pgrust-client.js";

test("pgrust wire results stay structured", () => {
  const result = resultFromWorker({
    engine: "wire",
    ms: 12,
    wire: {
      columns: [{ name: "pathway", typeid: 25 }, { name: "count", typeid: 23 }],
      rows: [["Apoptosis", "2"]],
      error: null,
      tag: "SELECT 1",
    },
  });

  assert.equal(result.kind, "table");
  assert.deepEqual(result.columns, ["pathway", "count"]);
  assert.deepEqual(result.rows, [["Apoptosis", "2"]]);
  assert.deepEqual(result.aligns, ["left", "right"]);
});

test("pgrust diagnostics can drive query repair", () => {
  const result = resultFromWorker({
    engine: "wire",
    ms: 4,
    wire: { error: { severity: "ERROR", message: "column missing does not exist" } },
  });

  assert.equal(result.kind, "error");
  assert.match(result.text, /missing/);
});
