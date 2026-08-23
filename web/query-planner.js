const identifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function buildCatalog(leaves) {
  const tables = new Map();
  for (const leaf of leaves) {
    if (leaf.name === "_tree") continue;
    if (!tables.has(leaf.name)) {
      tables.set(leaf.name, { name: leaf.name, fields: new Map(), rows: new Set() });
    }
    const table = tables.get(leaf.name);
    table.rows.add(leaf.id);
    if (!table.fields.has(leaf.path)) {
      table.fields.set(leaf.path, { name: leaf.path, type: leaf.data_type });
    }
  }
  return [...tables.values()]
    .map((table) => ({
      name: table.name,
      rowCount: table.rows.size,
      fields: [...table.fields.values()].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildSql(plan, catalog) {
  if (plan.operation === "tree") return treeSql();
  const table = catalog.find((item) => item.name === plan.table);
  if (!table) return "SELECT 'Choose a table' AS next_step;";

  const selected = plan.fields.length ? plan.fields : table.fields.map((field) => field.name);
  const fields = table.fields.filter((field) => selected.includes(field.name));
  const records = recordCte(table, fields);
  const where = filterSql(plan.filter, table);

  if (plan.operation === "count") {
    return `${records}\nSELECT count(*) AS row_count\nFROM records${where};`;
  }

  if (plan.operation === "sum" || plan.operation === "average") {
    const numeric = fields.find((field) => field.type === "number")
      || table.fields.find((field) => field.type === "number");
    if (!numeric) return `${records}\nSELECT count(*) AS row_count\nFROM records${where};`;
    const functionName = plan.operation === "sum" ? "sum" : "avg";
    const alias = plan.operation === "sum" ? "total" : "average";
    return `${records}\nSELECT ${functionName}(${identifier(numeric.name)}) AS ${alias}\nFROM records${where};`;
  }

  const columns = fields.length
    ? fields.map((field) => identifier(field.name)).join(",\n    ")
    : "*";
  return `${records}\nSELECT\n    ${columns}\nFROM records${where}\nORDER BY id\nLIMIT 100;`;
}

export function preview(plan, leaves, catalog) {
  if (plan.operation === "tree") return previewTree(leaves);
  const table = catalog.find((item) => item.name === plan.table);
  if (!table) return { columns: [], rows: [] };
  const selected = plan.fields.length ? plan.fields : table.fields.map((field) => field.name);
  const records = new Map();

  for (const leaf of leaves.filter((item) => item.name === table.name)) {
    if (!records.has(leaf.id)) records.set(leaf.id, { id: leaf.id, parent_id: leaf.parent_id });
    records.get(leaf.id)[leaf.path] = leaf.value;
  }

  let rows = [...records.values()];
  rows = rows.filter((row) => matchesFilter(row, plan.filter, table));

  if (plan.operation === "count") {
    return { columns: ["row_count"], rows: [{ row_count: rows.length }] };
  }

  if (plan.operation === "sum" || plan.operation === "average") {
    const numeric = table.fields.find(
      (field) => field.type === "number" && selected.includes(field.name),
    ) || table.fields.find((field) => field.type === "number");
    const values = numeric ? rows.map((row) => Number(row[numeric.name])).filter(Number.isFinite) : [];
    const total = values.reduce((sum, value) => sum + value, 0);
    const key = plan.operation === "sum" ? "total" : "average";
    const value = plan.operation === "sum" ? total : values.length ? total / values.length : null;
    return { columns: [key], rows: [{ [key]: value }] };
  }

  return {
    columns: selected,
    rows: rows.map((row) => Object.fromEntries(selected.map((field) => [field, row[field]]))),
  };
}

function recordCte(table, fields) {
  const projections = fields.map((field) => {
    const value = field.type === "number" ? "value::numeric" : "value";
    return `        max(${value}) FILTER (WHERE path = ${literal(field.name)}) AS ${identifier(field.name)}`;
  });
  const separator = projections.length ? ",\n" : "\n";
  return `WITH records AS (\n    SELECT\n        id,\n        parent_id${separator}${projections.join(",\n")}\n    FROM nodes\n    WHERE name = ${literal(table.name)}\n    GROUP BY id, parent_id\n)`;
}

function filterSql(filter, table) {
  if (!filter?.field || filter.value === "") return "";
  const field = table.fields.find((item) => item.name === filter.field);
  if (!field) return "";
  const column = identifier(field.name);
  const value = field.type === "number" ? Number(filter.value) : filter.value;
  const safeValue = field.type === "number" && Number.isFinite(value) ? String(value) : literal(value);
  const expression = {
    equals: `${column} = ${safeValue}`,
    contains: `${column}::text ILIKE ${literal(`%${filter.value}%`)}`,
    greater: `${column} > ${safeValue}`,
    less: `${column} < ${safeValue}`,
  }[filter.operator];
  return expression ? `\nWHERE ${expression}` : "";
}

function treeSql() {
  return `WITH RECURSIVE tree AS (
    SELECT id, parent_id, value AS table_name, 0 AS depth
    FROM nodes
    WHERE name = '_tree' AND parent_id IS NULL
    UNION ALL
    SELECT child.id, child.parent_id, child.value, tree.depth + 1
    FROM tree
    JOIN nodes AS child
      ON child.parent_id = tree.id
     AND child.name = '_tree'
)
SELECT id, parent_id, table_name, depth
FROM tree
ORDER BY depth, table_name;`;
}

function previewTree(leaves) {
  const nodes = leaves
    .filter((leaf) => leaf.name === "_tree")
    .map((leaf) => ({
      id: leaf.id,
      parent_id: leaf.parent_id,
      table_name: leaf.value,
      depth: depthFor(leaf, leaves),
    }));
  return { columns: ["table_name", "depth", "id"], rows: nodes };
}

function depthFor(leaf, leaves) {
  let depth = 0;
  let parent = leaf.parent_id;
  while (parent) {
    depth += 1;
    parent = leaves.find((item) => item.name === "_tree" && item.id === parent)?.parent_id;
  }
  return depth;
}

function matchesFilter(row, filter, table) {
  if (!filter?.field || filter.value === "") return true;
  const field = table.fields.find((item) => item.name === filter.field);
  const actual = row[filter.field];
  if (field?.type === "number") {
    const left = Number(actual);
    const right = Number(filter.value);
    if (filter.operator === "greater") return left > right;
    if (filter.operator === "less") return left < right;
    return left === right;
  }
  const left = String(actual ?? "").toLowerCase();
  const right = String(filter.value).toLowerCase();
  if (filter.operator === "contains") return left.includes(right);
  return left === right;
}
