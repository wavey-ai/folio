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

test("relationship report joins child records through parent ids", () => {
  const sql = buildSql({ operation: "pathway-components" }, []);

  assert.match(sql, /reference\.parent_id = parent\.id/);
  assert.match(sql, /component\.pathway_id = ltrim\(reference\.resource_id, '#'\)/);
  assert.match(sql, /Programmed Cell Death/);
});

test("relationship preview resolves component pathway names", () => {
  const relationshipLeaves = [
    {
      id: "parent",
      parent_id: "root",
      name: "reactome_pathways__bp:pathway",
      path: "@rdf:id",
      value: "Pathway1",
      data_type: "string",
    },
    {
      id: "parent",
      parent_id: "root",
      name: "reactome_pathways__bp:pathway",
      path: "bp:display_name__$text",
      value: "Programmed Cell Death",
      data_type: "string",
    },
    {
      id: "component",
      parent_id: "root",
      name: "reactome_pathways__bp:pathway",
      path: "@rdf:id",
      value: "Pathway2",
      data_type: "string",
    },
    {
      id: "component",
      parent_id: "root",
      name: "reactome_pathways__bp:pathway",
      path: "bp:display_name__$text",
      value: "Apoptosis",
      data_type: "string",
    },
    {
      id: "reference",
      parent_id: "parent",
      name: "reactome_pathways__bp:pathway__bp:pathway_component",
      path: "@rdf:resource",
      value: "#Pathway2",
      data_type: "string",
    },
  ];

  const result = preview(
    { operation: "pathway-components" },
    relationshipLeaves,
    buildCatalog(relationshipLeaves),
  );

  assert.deepEqual(result.columns, ["pathway", "component"]);
  assert.deepEqual(result.rows, [{ pathway: "Programmed Cell Death", component: "Apoptosis" }]);
});
