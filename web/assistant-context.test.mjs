import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExternalModelPrompt,
  buildRepairPrompt,
  buildSchemaChatPrompt,
  buildSystemPrompt,
  parseSchemaChatResponse,
  schemaChatAnswerDraft,
  schemaChatSqlDraft,
  validateProposal,
  validateReadQuery,
} from "./assistant-context.js";

const context = {
  document: { tableCount: 2, valueCount: 12 },
  relationships: [{
    type: "contains",
    parent: "report__customers",
    child: "report__customers__orders",
    join: "child.parent_id = parent.id",
  }],
  tables: [
    { name: "report__customers", fields: ['name:string="Jam Cafe"', "spend:number=125"] },
    { name: "report__customers__orders", fields: ['date:string="2026-08-23"', "total:number=75"] },
  ],
};

test("system prompt explains records and structural joins", () => {
  const prompt = buildSystemPrompt(context);

  assert.match(prompt, /child\.parent_id = parent\.id/);
  assert.match(prompt, /max\(value\) FILTER/);
  assert.match(prompt, /physical identifier columns are id and parent_id/);
  assert.match(prompt, /Filter aggregate results with HAVING/);
  assert.match(prompt, /B-tree indexes on \(name, id\), \(parent_id\), and \(name, path\)/);
  assert.match(prompt, /WITH RECURSIVE when the question requires/);
  assert.match(prompt, /report__customers/);
  assert.match(prompt, /child_record\.parent_id = parent_record\.id/);
});

test("external model prompt includes the question and schema", () => {
  const prompt = buildExternalModelPrompt(context, "Show customer spend");

  assert.match(prompt, /Show customer spend/);
  assert.match(prompt, /report__customers/);
  assert.match(prompt, /B-tree indexes/);
  assert.match(prompt, /unknown depth/);
  assert.match(prompt, /short document value/);
  assert.match(prompt, /Return only the PostgreSQL query/);
});

test("schema chat prompt supports explanations and report planning", () => {
  const prompt = buildSchemaChatPrompt(context);

  assert.match(prompt, /Treat every user message as report requirements/);
  assert.match(prompt, /PostgreSQL supplies all result rows and totals after execution/);
  assert.match(prompt, /parent_id connects a nested record/);
  assert.match(prompt, /ordinary joins for known parent-child hops/);
  assert.match(prompt, /report__customers/);
  assert.match(prompt, /complete query in sql/);
  assert.doesNotMatch(prompt, /Your short answer/);
  assert.doesNotMatch(prompt, /specific answer/);
});

test("schema chat extracts a grammar-constrained JSON query", () => {
  const raw = JSON.stringify({
    sql: "SELECT value FROM nodes WHERE name = 'report__customers' LIMIT 100;",
  });

  assert.equal(schemaChatAnswerDraft(raw), "");
  assert.equal(
    schemaChatSqlDraft(`{"sql":"SELECT value FROM nodes\\nWHERE name = 'report__customers'`),
    "SELECT value FROM nodes\nWHERE name = 'report__customers'",
  );
  assert.deepEqual(parseSchemaChatResponse(raw, ["report__customers"]), {
    answer: "Folio wrote the report query below.",
    sql: "SELECT value FROM nodes WHERE name = 'report__customers' LIMIT 100;",
    tables: ["report__customers"],
    assumptions: [],
  });
});

test("schema chat response ends in a parsable report query", () => {
  const raw = `<folio-answer>
Customer spend is stored on each customer record.
</folio-answer>
<folio-query>
SELECT value FROM nodes WHERE name = 'report__customers' LIMIT 100;
</folio-query>`;

  assert.equal(schemaChatAnswerDraft(raw), "Customer spend is stored on each customer record.");
  assert.deepEqual(parseSchemaChatResponse(raw, ["report__customers"]), {
    answer: "Customer spend is stored on each customer record.",
    sql: "SELECT value FROM nodes WHERE name = 'report__customers' LIMIT 100;",
    tables: ["report__customers"],
    assumptions: [],
  });
});

test("schema chat parser recovers a terminal fenced query", () => {
  const proposal = parseSchemaChatResponse(`Customer spend is queryable.\n\n\`\`\`sql
SELECT value FROM nodes WHERE name = 'report__customers';
\`\`\``);

  assert.equal(proposal.answer, "Customer spend is queryable.");
  assert.match(proposal.sql, /^SELECT value/);
});

test("schema chat exposes a partial tagged query while it is written", () => {
  const draft = `<folio-answer>Your short answer.</folio-answer>
<folio-query>
WITH records AS (
  SELECT id, parent_id FROM nodes`;

  assert.equal(schemaChatAnswerDraft(draft), "");
  assert.equal(
    schemaChatSqlDraft(draft),
    "WITH records AS (\n  SELECT id, parent_id FROM nodes",
  );
});

test("schema chat replaces a copied answer instruction with useful status", () => {
  const proposal = parseSchemaChatResponse(`<folio-answer>Your short answer.</folio-answer>
<folio-query>SELECT value FROM nodes LIMIT 10;</folio-query>`);

  assert.equal(proposal.answer, "Folio wrote the report query below.");
});

test("schema chat keeps the first complete query when the model repeats itself", () => {
  const proposal = parseSchemaChatResponse(`<folio-answer>
The first report is ready.
</folio-answer>
<folio-query>
SELECT value FROM nodes WHERE name = 'report__artist' LIMIT 10;
SELECT value FROM nodes WHERE name = 'report__release' LIMIT 10;
</folio-query>`, ["report__artist", "report__release"]);

  assert.equal(
    proposal.sql,
    "SELECT value FROM nodes WHERE name = 'report__artist' LIMIT 10;",
  );
});

test("schema chat keeps semicolons inside SQL values", () => {
  const proposal = parseSchemaChatResponse(`<folio-answer>Ready.</folio-answer>
<folio-query>
SELECT value FROM nodes WHERE value = 'A; B' LIMIT 10;
SELECT value FROM nodes LIMIT 1;
</folio-query>`, ["nodes"]);

  assert.equal(proposal.sql, "SELECT value FROM nodes WHERE value = 'A; B' LIMIT 10;");
});

test("query validator accepts a relationship report", () => {
  const sql = `WITH records AS (
    SELECT id, parent_id, max(value) FILTER (WHERE path = 'name') AS name
    FROM nodes
    GROUP BY id, parent_id
  )
  SELECT child.name FROM records child JOIN records parent ON child.parent_id = parent.id;`;

  assert.equal(validateReadQuery(sql), sql);
});

test("query validator keeps report operations read only", () => {
  assert.throws(() => validateReadQuery("DELETE FROM nodes"), /SELECT or WITH/);
  assert.throws(
    () => validateReadQuery("WITH removed AS (DELETE FROM nodes RETURNING *) SELECT * FROM removed"),
    /read-only/,
  );
});

test("query validator catches an identifier that no CTE defines", () => {
  assert.throws(
    () => validateReadQuery(`WITH item AS (
      SELECT id, parent_id FROM nodes
    )
    SELECT count(DISTINCT artist_id) FROM item;`),
    /artist_id before a CTE defines it/,
  );
  assert.doesNotThrow(() => validateReadQuery(`WITH item AS (
    SELECT id AS artist_id FROM nodes
  )
  SELECT count(DISTINCT artist_id) FROM item;`));
});

test("proposal validation and repair prompt preserve the diagnostic", () => {
  const proposal = {
    answer: "Show customer names.",
    sql: "SELECT value FROM nodes WHERE name = 'report__customers' LIMIT 100;",
    tables: ["report__customers"],
    assumptions: [],
  };

  assert.equal(validateProposal(proposal), proposal);
  assert.match(buildRepairPrompt({ question: "Customers", proposal, error: "field", context }), /field/);
});
