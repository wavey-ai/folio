import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalog, buildSql, preview } from "./query-planner.js";

const leaves = [
  { id: "root", parent_id: null, name: "_tree", path: "", value: "report", data_type: "tree" },
  { id: "one", parent_id: "root", name: "report__rows", path: "name", value: "Revenue", data_type: "string" },
  { id: "one", parent_id: "root", name: "report__rows", path: "amount", value: "125.5", data_type: "number" },
  { id: "two", parent_id: "root", name: "report__rows", path: "name", value: "Costs", data_type: "string" },
  { id: "two", parent_id: "root", name: "report__rows", path: "amount", value: "80", data_type: "number" },
];

test("catalog groups fields and records", () => {
  const [table] = buildCatalog(leaves);
  assert.equal(table.name, "report__rows");
  assert.equal(table.rowCount, 2);
  assert.deepEqual(table.fields.map((field) => field.name), ["amount", "name"]);
});

test("query plan creates typed aggregate SQL", () => {
  const catalog = buildCatalog(leaves);
  const sql = buildSql({
    table: "report__rows",
    operation: "sum",
    fields: ["amount"],
    filter: { field: "amount", operator: "greater", value: "100" },
  }, catalog);

  assert.match(sql, /max\(value::numeric\)/);
  assert.match(sql, /sum\("amount"\) AS total/);
  assert.match(sql, /WHERE "amount" > 100/);
});

test("local preview follows the query plan", () => {
  const catalog = buildCatalog(leaves);
  const result = preview({
    table: "report__rows",
    operation: "rows",
    fields: ["name", "amount"],
    filter: { field: "amount", operator: "greater", value: "100" },
  }, leaves, catalog);

  assert.deepEqual(result.columns, ["name", "amount"]);
  assert.deepEqual(result.rows, [{ name: "Revenue", amount: "125.5" }]);
});

test("text search works with each inferred field type", () => {
  const catalog = buildCatalog(leaves);
  const sql = buildSql({
    table: "report__rows",
    operation: "count",
    fields: ["amount"],
    filter: { field: "amount", operator: "contains", value: "25" },
  }, catalog);

  assert.match(sql, /"amount"::text ILIKE '%25%'/);
});
