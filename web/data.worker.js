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
      result = assistantContext(data.tableNames || []);
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

function assistantContext(requestedNames) {
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

  const chosen = new Set(requestedNames.filter((name) => catalog.some((table) => table.name === name)));
  if (!chosen.size) catalog.slice(0, 12).forEach((table) => chosen.add(table.name));
  for (const name of [...chosen]) {
    for (const parent of parents.get(name) || []) chosen.add(parent);
    for (const child of children.get(name) || []) chosen.add(child);
  }

  const samples = new Map();
  for (const leaf of leaves) {
    if (leaf.name === "_tree" || !chosen.has(leaf.name)) continue;
    const key = `${leaf.name}\u0000${leaf.path}`;
    if (!samples.has(key)) samples.set(key, []);
    const values = samples.get(key);
    const value = String(leaf.value).slice(0, 120);
    if (values.length < 3 && !values.includes(value)) values.push(value);
  }

  return {
    document: {
      label: documentLabel,
      tableCount: catalog.length,
      valueCount: leaves.reduce((count, leaf) => count + Number(leaf.name !== "_tree"), 0),
    },
    allTables: catalog.map((table) => ({
      name: table.name,
      fields: table.fields.map((field) => `${field.name}:${field.type}`),
    })),
    relevantTables: catalog
      .filter((table) => chosen.has(table.name))
      .map((table) => ({
        name: table.name,
        rowCount: table.rowCount,
        parentTables: [...(parents.get(table.name) || [])],
        childTables: [...(children.get(table.name) || [])],
        fields: table.fields.map((field) => ({
          name: field.name,
          type: field.type,
          samples: samples.get(`${table.name}\u0000${field.name}`) || [],
        })),
      })),
  };
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
