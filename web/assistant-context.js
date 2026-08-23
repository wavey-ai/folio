export const QUERY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    sql: {
      type: "string",
      description: "One read-only PostgreSQL SELECT or WITH query.",
    },
    answer: {
      type: "string",
      description: "A short explanation of the report and its result columns.",
    },
    tables: {
      type: "array",
      items: { type: "string" },
      description: "The inferred table names used by the query.",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "Data interpretations that help the user review the query.",
    },
  },
  required: ["sql", "answer", "tables", "assumptions"],
  additionalProperties: false,
};

export function buildSystemPrompt(context) {
  return `Create a PostgreSQL report for Folio.

The document is in one table:
- nodes(id TEXT, parent_id TEXT, name TEXT, path TEXT, data_type TEXT, value TEXT)

Rows with the same name and id are one inferred record. Pivot fields with:
max(value) FILTER (WHERE path = 'field').

Join contained records with child.parent_id = parent.id. XML attributes start with @. Element text uses $text. Resolve RDF #references with ltrim(reference, '#').

Return one read-only SELECT or WITH query. Use only the supplied names and paths. Use clear aliases. Limit row reports to 100 rows.

Return the constrained object with answer, sql, tables, and assumptions.

Relevant schema:
${JSON.stringify(context)}`;
}

export function buildRepairPrompt({ question, proposal, error }) {
  return `Repair the PostgreSQL query for this question:
${question}

Previous PostgreSQL:
${proposal.sql}

PostgreSQL diagnostic:
${JSON.stringify(error)}

Return a corrected constrained response. Preserve the user's requested meaning.`;
}

export function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object") {
    throw new Error("Folio received an incomplete query plan.");
  }
  if (typeof proposal.answer !== "string" || typeof proposal.sql !== "string") {
    throw new Error("Folio received an incomplete query plan.");
  }
  if (!Array.isArray(proposal.tables) || !Array.isArray(proposal.assumptions)) {
    throw new Error("Folio received an incomplete query plan.");
  }
  validateReadQuery(proposal.sql);
  return proposal;
}

export function validateReadQuery(sql) {
  const trimmed = String(sql).trim();
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Folio accepts a SELECT or WITH report query.");
  }

  const code = stripLiteralsAndComments(trimmed).replace(/;\s*$/, "");
  if (code.includes(";")) {
    throw new Error("Folio accepts one report query at a time.");
  }
  if (/\b(insert|update|delete|merge|drop|alter|create|truncate|copy|call|do|grant|revoke|vacuum)\b/i.test(code)) {
    throw new Error("Folio accepts read-only report operations.");
  }
  if (!/\bnodes\b/i.test(code)) {
    throw new Error("The report query must read the inferred nodes table.");
  }
  return trimmed;
}

function stripLiteralsAndComments(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}
