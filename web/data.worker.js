import { buildCatalog, buildSql, preview } from "./query-planner.js";

let leaves = [];
let catalog = [];
let documentLabel = "document";

self.addEventListener("message", ({ data }) => {
  const { id, operation } = data;
  try {
    let result;
    if (operation === "load") {
      leaves = JSON.parse(new TextDecoder().decode(data.buffer));
      catalog = buildCatalog(leaves);
      documentLabel = data.label || "document";
      result = {
        catalog,
        valueCount: leaves.reduce((count, leaf) => count + Number(leaf.name !== "_tree"), 0),
        leafCount: leaves.length,
      };
    } else if (operation === "sql") {
      result = buildSql(data.plan, catalog);
    } else if (operation === "preview") {
      result = preview(data.plan, leaves, catalog);
    } else if (operation === "assistantContext") {
      result = assistantContext(data.tableNames || [], data.question || "");
    } else if (operation === "postgresSchema") {
      result = postgresSchema();
    } else if (operation === "postgresBatch") {
      result = postgresBatch(data.offset || 0, data.limit || 5_000);
    } else if (operation === "postgresIndexes") {
      result = `CREATE INDEX nodes_name_id_idx ON nodes (name, id);
CREATE INDEX nodes_parent_id_idx ON nodes (parent_id);
CREATE INDEX nodes_name_path_idx ON nodes (name, path);`;
    } else {
      throw new Error(`Unknown data operation: ${operation}`);
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});

function assistantContext(requestedNames, question) {
  const treeNames = new Map(
    leaves.filter((leaf) => leaf.name === "_tree").map((leaf) => [leaf.id, leaf.value]),
  );
  const parents = new Map();
  const children = new Map();

  for (const leaf of leaves) {
    if (leaf.name === "_tree" || !leaf.parent_id) continue;
    const parentName = treeNames.get(leaf.parent_id);
    if (!parentName || parentName === leaf.name) continue;
    addRelation(parents, leaf.name, parentName);
    addRelation(children, parentName, leaf.name);
  }

  const catalogNames = new Set(catalog.map((table) => table.name));
  const requested = [...new Set(requestedNames)]
    .filter((name) => catalogNames.has(name))
    .slice(0, 6);
  if (!requested.length) requested.push(...catalog.slice(0, 4).map((table) => table.name));

  const chosen = new Set(requested);
  for (const name of requested) {
    for (const related of [...(parents.get(name) || []), ...(children.get(name) || [])]) {
      if (chosen.size >= 8) break;
      chosen.add(related);
    }
  }

  const samples = new Map();
  for (const leaf of leaves) {
    if (leaf.name === "_tree" || !chosen.has(leaf.name)) continue;
    const key = `${leaf.name}\u0000${leaf.path}`;
    if (!samples.has(key)) samples.set(key, []);
    const values = samples.get(key);
    const value = String(leaf.value).slice(0, 60);
    if (!values.length) values.push(value);
  }

  const questionTerms = String(question)
    .toLowerCase()
    .split(/[^a-z0-9@:$]+/)
    .filter((term) => term.length >= 3);

  return {
    document: documentLabel,
    tableCount: catalog.length,
    tables: catalog
      .filter((table) => chosen.has(table.name))
      .map((table) => ({
        name: table.name,
        rows: table.rowCount,
        parents: [...(parents.get(table.name) || [])].slice(0, 4),
        children: [...(children.get(table.name) || [])].slice(0, 4),
        fields: [...table.fields]
          .sort((left, right) => fieldScore(right.name, questionTerms) - fieldScore(left.name, questionTerms))
          .slice(0, 14)
          .map((field, index) => {
            const example = samples.get(`${table.name}\u0000${field.name}`)?.[0];
            return example === undefined || index >= 4
              ? `${field.name}:${field.type}`
              : `${field.name}:${field.type}=${JSON.stringify(example)}`;
          }),
      })),
  };
}

function fieldScore(name, questionTerms) {
  const normalized = name.toLowerCase().replaceAll("_", " ");
  const matches = questionTerms.reduce(
    (score, term) => score + Number(normalized.includes(term)) * 10,
    0,
  );
  const structural = /(^|[:/@_])(id|name|title|display|ref|resource|text|type|date|value)\b/i.test(name)
    ? 2
    : 0;
  return matches + structural;
}

function addRelation(map, source, target) {
  if (!map.has(source)) map.set(source, new Set());
  map.get(source).add(target);
}

function postgresSchema() {
  return `DROP TABLE IF EXISTS nodes CASCADE;
CREATE TABLE nodes (
    id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    data_type TEXT NOT NULL,
    value TEXT
);`;
}

function postgresBatch(offset, limit) {
  const batch = leaves.slice(offset, offset + limit);
  const values = batch.map((leaf) => `(${[
    leaf.id,
    leaf.parent_id,
    leaf.name,
    leaf.path,
    leaf.data_type,
    scalarValue(leaf.value),
  ].map(sqlLiteral).join(", ")})`);
  const nextOffset = offset + batch.length;
  return {
    sql: values.length
      ? `INSERT INTO nodes (id, parent_id, name, path, data_type, value) VALUES\n${values.join(",\n")};`
      : "",
    nextOffset,
    total: leaves.length,
    done: nextOffset >= leaves.length,
  };
}

function scalarValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}
