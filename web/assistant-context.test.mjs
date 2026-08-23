import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRepairPrompt,
  buildSystemPrompt,
  validateProposal,
  validateReadQuery,
} from "./assistant-context.js";

const context = {
  document: { tableCount: 2, valueCount: 12 },
  relevantTables: [{ name: "report__customers", fields: ["name", "spend"] }],
};

test("system prompt explains records and structural joins", () => {
  const prompt = buildSystemPrompt(context);

  assert.match(prompt, /child\.parent_id = parent\.id/);
  assert.match(prompt, /max\(value\) FILTER/);
  assert.match(prompt, /report__customers/);
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

test("proposal validation and repair prompt preserve context", () => {
  const proposal = {
    answer: "Show customer names.",
    sql: "SELECT value FROM nodes WHERE name = 'report__customers' LIMIT 100;",
    tables: ["report__customers"],
    assumptions: [],
  };

  assert.equal(validateProposal(proposal), proposal);
  assert.match(buildRepairPrompt({ question: "Customers", proposal, error: "field", context }), /field/);
});
