export const QUERY_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "A short explanation of the report and its result columns.",
    },
    sql: {
      type: "string",
      description: "One read-only PostgreSQL SELECT or WITH query.",
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
  required: ["answer", "sql", "tables", "assumptions"],
  additionalProperties: false,
};

export function buildSystemPrompt(context) {
  return `You are Folio's PostgreSQL report planner.

Folio converts a nested JSON or XML document into one PostgreSQL table named nodes.

nodes has these columns:
- id TEXT: the stable identifier for one inferred record.
- parent_id TEXT: the containing record identifier. Join a child record to its parent with child.parent_id = parent.id.
- name TEXT: the inferred table name.
- path TEXT: the scalar field path within the inferred record.
- data_type TEXT: string, number, or boolean.
- value TEXT: the scalar value. Cast value for numeric and date operations.

Rows with the same name and id form one record. Pivot those rows with max(value) FILTER (WHERE path = 'field'). Repeated arrays create child tables. The _tree rows connect every record to its inferred table name. XML attributes start with @. XML element text uses $text. RDF references use values such as #Pathway2 and can resolve to an @rdf:id field with ltrim(reference, '#').

Create one read-only PostgreSQL query that answers the user's question. Start with SELECT or WITH. Use CTEs to pivot records. Use parent_id for structural joins. Use identifiers and field paths from the supplied schema. Include clear result column aliases. Use LIMIT 100 for row reports. Return aggregates at their natural size.

Return the constrained response object. Put the query in sql. Put a concise user-facing explanation in answer. List every inferred table in tables. State useful interpretations in assumptions.

Loaded document context:
${JSON.stringify(context)}`;
}

export function buildRepairPrompt({ question, proposal, error, context }) {
  return `Repair the PostgreSQL query for this question:
${question}

Previous constrained response:
${JSON.stringify(proposal)}

PostgreSQL diagnostic:
${JSON.stringify(error)}

Relevant loaded document context:
${JSON.stringify(context)}

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
