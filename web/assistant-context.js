export function buildSystemPrompt(context) {
  const queryPattern = buildQueryPattern(context);
  return `Write the PostgreSQL query that Folio will run to create a report.

Treat the user's message as report requirements. Your response supplies the query. PostgreSQL supplies all result rows and totals after execution.

The database has exactly one physical table:
- nodes(id TEXT, parent_id TEXT, name TEXT, path TEXT, data_type TEXT, value TEXT)

PostgreSQL has B-tree indexes on (name, id), (parent_id), and (name, path).

Every FROM or JOIN target must be nodes or a CTE that reads nodes. Context table names are values for nodes.name. They are not physical PostgreSQL tables.

Rows with the same name and id are one inferred record. Pivot fields with:
max(value) FILTER (WHERE path = 'field').

An aggregate CTE must group every selected id and parent_id.
The physical identifier columns are id and parent_id. Create each derived identifier alias explicitly from one of those columns.
Each CTE exposes only the columns in its SELECT list. Trace every later column reference to that list.
Filter aggregate results with HAVING or with an outer SELECT.

Join contained records with child.parent_id = parent.id. XML attributes start with @. Element text uses $text. Resolve RDF #references with ltrim(reference, '#').
Use ordinary joins when the relationship depth is known. Use WITH RECURSIVE when the question requires ancestors or descendants at an unknown depth.
Match literal filters to supplied field examples. Prefer an exact example match over a similar table or field name.

The context relationships are verified from this document. Use containment edges for nesting and reference edges for linked records.
Context fields use path:type=example when a short document value is available. Examples are values, not path syntax.

Return one read-only SELECT or WITH query. Use only the supplied names and paths. Use clear aliases. Limit row reports to 100 rows.

Use this short pattern, which Folio built from the supplied schema:
${queryPattern}

Put the complete query in the sql property of the required response object. Start with SELECT or WITH. End after one semicolon.

Relevant schema:
${JSON.stringify(context)}`;
}

export function buildSchemaChatPrompt(context) {
  const queryPattern = buildQueryPattern(context);
  return `You write PostgreSQL report queries for Folio.

Treat every user message as report requirements. Your response supplies a query that answers the message. PostgreSQL supplies all result rows and totals after execution.

The database has one physical table:
nodes(id TEXT, parent_id TEXT, name TEXT, path TEXT, data_type TEXT, value TEXT)

PostgreSQL has B-tree indexes on (name, id), (parent_id), and (name, path).

Rows with the same name and id form one inferred record. parent_id connects a nested record to its container. XML attributes start with @. Element text uses $text.
Use ordinary joins for known parent-child hops. Use WITH RECURSIVE only for traversal at an unknown depth.
Match requested literal values to the supplied field examples.

Use the supplied schema names and paths accurately.
Context fields use path:type=example when a short document value is available. Examples are values, not path syntax.

The sql property is exactly one read-only PostgreSQL report query. It must read nodes or a CTE that reads nodes. Use only supplied names and paths. Limit row reports to 100 rows.

Use this short pattern, which Folio built from the supplied schema:
${queryPattern}

Return one object that matches the required response schema. Put the complete query in sql.

Relevant schema:
${JSON.stringify(context)}`;
}

export function schemaChatAnswerDraft(content) {
  const clean = stripThinking(content);
  if (/^\s*\{/.test(clean)) return "";
  const tagged = clean.match(/<folio[-_]answer>\s*([\s\S]*?)(?:<\/folio[-_]answer>|$)/i);
  if (tagged) return normalizeSchemaChatAnswer(tagged[1]);
  const queryStart = clean.search(/<folio[-_]query>/i);
  const fenceStart = clean.search(/```(?:postgresql|sql)?\s*(?:select|with)\b/i);
  const answerEnd = queryStart >= 0 ? queryStart : fenceStart >= 0 ? fenceStart : clean.length;
  return normalizeSchemaChatAnswer(clean.slice(0, answerEnd)
    .replace(/<\/?folio[-_]answer>/gi, "")
    .trim());
}

export function schemaChatSqlDraft(content) {
  const clean = stripThinking(content);
  const structured = partialJsonString(clean, "sql");
  if (structured) return structured;
  const tagged = clean.match(/<folio[-_]query>\s*([\s\S]*?)(?:<\/folio[-_]query>|$)/i);
  const fenced = clean.match(/```(?:postgresql|sql)?\s*([\s\S]*?)(?:```|$)/i);
  const directStart = clean.search(/(?:^|\n)\s*(?:select|with)\b/i);
  const direct = directStart >= 0 ? clean.slice(directStart).trim() : "";
  const source = stripSqlFence(tagged?.[1] || fenced?.[1] || direct);
  const start = source.search(/\b(?:select|with)\b/i);
  return start >= 0 ? firstSqlStatement(source.slice(start)) : "";
}

export function normalizeSchemaChatAnswer(value) {
  const answer = String(value || "").trim();
  if (/^(?:your\s+)?short answer\.?$/i.test(answer)) return "";
  if (/^(?:your\s+)?(?:answer|response)\.?$/i.test(answer)) return "";
  return answer;
}

export function parseSchemaChatResponse(content, tables = []) {
  const clean = stripThinking(content).trim();
  const structured = parseReportObject(clean);
  const queryTag = clean.match(/<folio[-_]query>\s*([\s\S]*?)(?:<\/folio[-_]query>|$)/i);
  const sql = structured?.sql?.trim()
    || firstSqlStatement(stripSqlFence(queryTag?.[1] || terminalSql(clean)));
  const answer = normalizeSchemaChatAnswer(structured?.summary)
    || schemaChatAnswerDraft(clean)
    || "Folio wrote the report query below.";
  return validateProposal({
    answer,
    sql,
    tables: [...new Set(tables.map((table) => typeof table === "string" ? table : table?.name).filter(Boolean))],
    assumptions: [],
  });
}

function parseReportObject(content) {
  const fenced = String(content).match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/i)?.[1]?.trim();
  for (const candidate of [String(content).trim(), fenced]) {
    if (!candidate?.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.sql === "string") return parsed;
    } catch {
      // A legacy tagged or fenced response can still contain a usable query.
    }
  }
  return null;
}

function partialJsonString(json, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(String(json));
  if (!match) return "";
  let output = "";
  for (let index = match.index + match[0].length; index < json.length; index += 1) {
    const character = json[index];
    if (character === '"') break;
    if (character !== "\\") {
      output += character;
      continue;
    }
    const escaped = json[++index];
    if (escaped === undefined) break;
    if (escaped === "n") output += "\n";
    else if (escaped === "r") output += "\r";
    else if (escaped === "t") output += "\t";
    else if (escaped === "b") output += "\b";
    else if (escaped === "f") output += "\f";
    else if (escaped === "u") {
      const code = json.slice(index + 1, index + 5);
      if (!/^[0-9a-f]{4}$/i.test(code)) break;
      output += String.fromCharCode(Number.parseInt(code, 16));
      index += 4;
    } else output += escaped;
  }
  return output;
}

function firstSqlStatement(value) {
  const sql = String(value || "").trim();
  const start = sql.search(/\b(?:select|with)\b/i);
  if (start < 0) return sql;
  const source = sql.slice(start);
  let quote = "";
  let dollarQuote = "";
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (dollarQuote) {
      if (source.startsWith(dollarQuote, index)) {
        index += dollarQuote.length - 1;
        dollarQuote = "";
      }
      continue;
    }
    if (quote) {
      if (character !== quote) continue;
      if (next === quote) {
        index += 1;
        continue;
      }
      quote = "";
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "$") {
      const tag = /^\$[a-z_][a-z0-9_]*\$|^\$\$/i.exec(source.slice(index))?.[0];
      if (tag) {
        dollarQuote = tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (character === ";") return source.slice(0, index + 1).trim();
  }
  return source.trim();
}

function terminalSql(content) {
  const fenced = [...content.matchAll(/```(?:postgresql|sql)?\s*([\s\S]*?)(?:```|$)/gi)].at(-1)?.[1];
  const source = fenced || content;
  const starts = [...source.matchAll(/\b(?:select|with)\b/gi)];
  if (!starts.length) return "";
  const candidate = source.slice(starts.at(-1).index).trim();
  const semicolon = candidate.lastIndexOf(";");
  return semicolon >= 0 ? candidate.slice(0, semicolon + 1) : candidate;
}

function stripSqlFence(value) {
  return String(value || "")
    .replace(/^```(?:postgresql|sql)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function stripThinking(content) {
  return String(content || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function buildRecordPattern(context) {
  const table = context?.tables?.[0];
  const fieldSpec = table?.fields?.find((field) => /display|name|title|text/i.test(field))
    || table?.fields?.[0];
  const tableName = sqlPromptLiteral(table?.name || "document__item");
  const fieldName = sqlPromptLiteral(
    String(fieldSpec || "displayName").replace(/:(?:string|number|boolean)(?:=.*)?$/i, ""),
  );
  return `WITH item AS (
  SELECT id, parent_id, max(value) FILTER (WHERE path = '${fieldName}') AS field_value
  FROM nodes WHERE name = '${tableName}' GROUP BY id, parent_id
)
SELECT field_value FROM item WHERE field_value IS NOT NULL LIMIT 100;`;
}

function buildQueryPattern(context) {
  const relationship = context?.relationships?.find((item) => item?.type === "contains");
  if (!relationship) return buildRecordPattern(context);
  const parent = context?.tables?.find((table) => table.name === relationship.parent);
  const child = context?.tables?.find((table) => table.name === relationship.child);
  if (!parent || !child) return buildRecordPattern(context);
  const parentPath = sqlPromptLiteral(promptFieldPath(parent.fields?.[0], "parent_field"));
  const childPath = sqlPromptLiteral(promptFieldPath(child.fields?.[0], "child_field"));
  return `WITH parent_record AS (
  SELECT id, max(value) FILTER (WHERE path = '${parentPath}') AS parent_value
  FROM nodes WHERE name = '${sqlPromptLiteral(parent.name)}' GROUP BY id
), child_record AS (
  SELECT id, parent_id, max(value) FILTER (WHERE path = '${childPath}') AS child_value
  FROM nodes WHERE name = '${sqlPromptLiteral(child.name)}' GROUP BY id, parent_id
)
SELECT parent_record.parent_value, child_record.child_value
FROM child_record JOIN parent_record ON child_record.parent_id = parent_record.id
LIMIT 100;`;
}

function promptFieldPath(field, fallback) {
  return String(field || fallback).replace(/:(?:string|number|boolean)(?:=.*)?$/i, "");
}

function sqlPromptLiteral(value) {
  return String(value).replaceAll("'", "''");
}

export function buildExternalModelPrompt(context, question) {
  return `Write the PostgreSQL query that answers this report question:
${question}

Your response supplies the query. PostgreSQL supplies all result rows and totals after execution.

The database has exactly one physical table:
nodes(id TEXT, parent_id TEXT, name TEXT, path TEXT, data_type TEXT, value TEXT)

PostgreSQL has B-tree indexes on (name, id), (parent_id), and (name, path).

Every FROM or JOIN target must be nodes or a CTE that reads nodes. Context table names are values for nodes.name. They are not physical PostgreSQL tables.

Rows with the same name and id are one inferred record. Pivot fields with:
max(value) FILTER (WHERE path = 'field').

The physical identifier columns are id and parent_id. Create each derived identifier alias explicitly from one of those columns.
Each CTE exposes only the columns in its SELECT list. Trace every later column reference to that list.
Filter aggregate results with HAVING or with an outer SELECT.

Join contained records with child.parent_id = parent.id. XML attributes start with @. Element text uses $text. Resolve RDF #references with ltrim(reference, '#').
Use ordinary joins when the relationship depth is known. Use WITH RECURSIVE when the question requires ancestors or descendants at an unknown depth.
Match literal filters to supplied field examples. Prefer an exact example match over a similar table or field name.

The context relationships are verified from this document. Use containment edges for nesting and reference edges for linked records.
Context fields use path:type=example when a short document value is available. Examples are values, not path syntax.

Return one read-only SELECT or WITH query. Use only the supplied names and paths. Use clear aliases. Limit row reports to 100 rows.

Use this short pattern, which Folio built from the supplied schema:
${buildQueryPattern(context)}

Relevant schema:
${JSON.stringify(context)}

Return only the PostgreSQL query.`;
}

export function buildRepairPrompt({ question, proposal, error }) {
  return `Repair the PostgreSQL query for this question:
${question}

Previous PostgreSQL:
${proposal.sql}

PostgreSQL diagnostic:
${JSON.stringify(error)}

Use id and parent_id as the physical identifiers. Define every derived identifier in its CTE SELECT list.
Trace each column reference to a physical column or an explicit CTE output alias.
Use HAVING or an outer SELECT for aggregate filters.

Return the corrected PostgreSQL query directly. Start with SELECT or WITH. End immediately after one semicolon. Preserve the user's requested meaning.`;
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
  validateDerivedIdentifiers(code);
  return trimmed;
}

function validateDerivedIdentifiers(code) {
  const aliases = new Set(
    [...code.matchAll(/\bas\s+"?([a-z_][a-z0-9_]*)"?/gi)]
      .map((match) => match[1].toLowerCase()),
  );
  const references = [...code.matchAll(/\b([a-z_][a-z0-9_]*_id)\b/gi)]
    .map((match) => match[1].toLowerCase());
  const invented = references.find(
    (name) => name !== "parent_id" && !aliases.has(name),
  );
  if (invented) {
    throw new Error(
      `The query uses ${invented} before a CTE defines it. Derive it explicitly from id or parent_id.`,
    );
  }
}

function stripLiteralsAndComments(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}
