import { buildCatalog, buildSql, preview } from "./query-planner.js";

let leaves = null;
let catalog = [];
let documentLabel = "document";

self.addEventListener("message", ({ data }) => {
  const { id, operation } = data;
  try {
    let result;
    if (operation === "load") {
      leaves = decodeRows(data.buffer);
      catalog = buildCatalog(leaves);
      documentLabel = data.label || "document";
      let valueCount = 0;
      for (const leaf of leaves) valueCount += Number(leaf.name !== "_tree");
      result = {
        catalog,
        valueCount,
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
    } else if (operation === "postgresCopyBatch") {
      result = postgresCopyBatch(data.offset || 0, data.limit || 50_000);
    } else if (operation === "postgresCopyBuffer") {
      result = postgresCopyBuffer(data.offset || 0, data.limit || 100_000);
    } else if (operation === "postgresIndexes") {
      result = `CREATE INDEX nodes_name_id_idx ON nodes (name, id);
CREATE INDEX nodes_parent_id_idx ON nodes (parent_id);
CREATE INDEX nodes_name_path_idx ON nodes (name, path);`;
    } else {
      throw new Error(`Unknown data operation: ${operation}`);
    }
    const transfer = result?.buffer instanceof ArrayBuffer ? [result.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});

const COMPACT_MAGIC = "J2LFC001";

function decodeRows(buffer) {
  const bytes = new Uint8Array(buffer);
  const compact = bytes.byteLength >= COMPACT_MAGIC.length
    && COMPACT_MAGIC.split("").every((character, index) => bytes[index] === character.charCodeAt(0));
  if (compact) return CompactRows.decode(buffer);
  return new JsonRows(JSON.parse(new TextDecoder().decode(bytes)));
}

class JsonRows {
  constructor(rows) {
    this.rows = rows;
    this.length = rows.length;
  }

  get(index, rawValue = false) {
    const leaf = this.rows[index];
    if (!rawValue || leaf.value === null || typeof leaf.value !== "object") return leaf;
    return { ...leaf, value: JSON.stringify(leaf.value) };
  }

  *[Symbol.iterator]() {
    yield* this.rows;
  }
}

class CompactRows {
  static decode(buffer) {
    const reader = new BinaryReader(buffer);
    reader.skip(COMPACT_MAGIC.length);
    const length = reader.u32();
    const prefix = reader.string();
    const names = reader.dictionary();
    const paths = reader.dictionary();
    const ids = new Uint32Array(length);
    const parents = new Uint32Array(length);
    const nameIds = new Uint32Array(length);
    const pathIds = new Uint32Array(length);
    const types = new Uint8Array(length);
    const valueOffsets = new Uint32Array(length);
    const valueLengths = new Uint32Array(length);

    for (let index = 0; index < length; index += 1) {
      ids[index] = reader.u32();
      parents[index] = reader.u32();
      nameIds[index] = reader.u32();
      pathIds[index] = reader.u32();
      types[index] = reader.u8();
      valueLengths[index] = reader.u32();
      valueOffsets[index] = reader.offset;
      reader.skip(valueLengths[index]);
      if (nameIds[index] >= names.length || pathIds[index] >= paths.length || types[index] > 2) {
        throw new Error("The mapped document uses an unsupported browser row format.");
      }
    }
    reader.finish();

    return new CompactRows({
      buffer,
      length,
      prefix,
      names,
      paths,
      ids,
      parents,
      nameIds,
      pathIds,
      types,
      valueOffsets,
      valueLengths,
    });
  }

  constructor(data) {
    Object.assign(this, data);
    this.bytes = new Uint8Array(data.buffer);
    this.decoder = new TextDecoder();
  }

  get(index, rawValue = false) {
    if (index < 0 || index >= this.length) return undefined;
    const type = this.types[index];
    const raw = this.decoder.decode(this.bytes.subarray(
      this.valueOffsets[index],
      this.valueOffsets[index] + this.valueLengths[index],
    ));
    let value = raw;
    if (!rawValue) {
      if (type === 1) value = Number(raw);
      else if (type === 2) value = raw === "true";
    }
    const parent = this.parents[index];
    return {
      id: this.id(this.ids[index]),
      parent_id: parent ? this.id(parent - 1) : null,
      name: this.names[this.nameIds[index]],
      path: this.paths[this.pathIds[index]],
      data_type: ["string", "number", "boolean"][type],
      value,
    };
  }

  id(number) {
    return `${this.prefix}-${number.toString(16)}`;
  }

  *[Symbol.iterator]() {
    for (let index = 0; index < this.length; index += 1) yield this.get(index);
  }
}

class BinaryReader {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.decoder = new TextDecoder();
    this.offset = 0;
  }

  u8() {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u32() {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  string() {
    const length = this.u32();
    this.require(length);
    const value = this.decoder.decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  dictionary() {
    const length = this.u32();
    const values = new Array(length);
    for (let index = 0; index < length; index += 1) values[index] = this.string();
    return values;
  }

  skip(length) {
    this.require(length);
    this.offset += length;
  }

  require(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new Error("The mapped document is incomplete.");
    }
  }

  finish() {
    if (this.offset !== this.bytes.byteLength) {
      throw new Error("The mapped document has trailing bytes.");
    }
  }
}

function assistantContext(requestedNames, question) {
  const treeNames = new Map();
  for (const leaf of leaves) {
    if (leaf.name === "_tree") treeNames.set(leaf.id, leaf.value);
  }
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

  const references = inferReferenceRelationships(chosen);
  for (const reference of references) {
    if (chosen.size >= 10) break;
    if (catalogNames.has(reference.to.table)) chosen.add(reference.to.table);
  }

  const questionTerms = String(question)
    .toLowerCase()
    .split(/[^a-z0-9@:$]+/)
    .filter((term) => term.length >= 3);

  const samples = new Map();
  for (const leaf of leaves) {
    if (leaf.name === "_tree" || !chosen.has(leaf.name)) continue;
    const key = `${leaf.name}\u0000${leaf.path}`;
    if (!samples.has(key)) samples.set(key, []);
    const values = samples.get(key);
    const value = String(leaf.value).slice(0, 60);
    if (!values.length) values.push(value);
    if (questionTerms.some((term) => value.toLowerCase().includes(term))
      && !values.includes(value)) {
      values.unshift(value);
      if (values.length > 3) values.length = 3;
    }
  }

  const containment = [];
  for (const child of chosen) {
    for (const parent of parents.get(child) || []) {
      if (!chosen.has(parent)) continue;
      containment.push({
        type: "contains",
        parent,
        child,
        join: "child.parent_id = parent.id",
      });
    }
  }

  return {
    document: documentLabel,
    tableCount: catalog.length,
    relationships: [
      ...containment.slice(0, 12),
      ...references.filter((reference) => chosen.has(reference.to.table)).slice(0, 8),
    ],
    tables: catalog
      .filter((table) => chosen.has(table.name))
      .map((table) => ({
        name: table.name,
        rows: table.rowCount,
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

function inferReferenceRelationships(chosen) {
  const sources = new Map();
  for (const leaf of leaves) {
    if (leaf.name === "_tree" || !chosen.has(leaf.name)) continue;
    const value = String(leaf.value);
    if (!value.startsWith("#") || value.length < 2) continue;
    const key = `${leaf.name}\u0000${leaf.path}`;
    if (!sources.has(key)) {
      sources.set(key, { table: leaf.name, path: leaf.path, values: new Set() });
    }
    const source = sources.get(key);
    if (source.values.size < 4) source.values.add(value.slice(1));
  }

  const wanted = new Set([...sources.values()].flatMap((source) => [...source.values]));
  if (!wanted.size) return [];

  const targets = new Map();
  for (const leaf of leaves) {
    if (leaf.name === "_tree" || !identifierPath(leaf.path)) continue;
    const value = String(leaf.value);
    if (!wanted.has(value)) continue;
    if (!targets.has(value)) targets.set(value, new Map());
    targets.get(value).set(`${leaf.name}\u0000${leaf.path}`, {
      table: leaf.name,
      path: leaf.path,
    });
  }

  const inferred = new Map();
  for (const source of sources.values()) {
    for (const value of source.values) {
      for (const target of targets.get(value)?.values() || []) {
        const key = `${source.table}\u0000${source.path}\u0000${target.table}\u0000${target.path}`;
        if (!inferred.has(key)) {
          inferred.set(key, {
            type: "references",
            from: { table: source.table, path: source.path },
            to: target,
            match: "ltrim(reference_value, '#') = identifier_value",
            examplesMatched: 0,
          });
        }
        inferred.get(key).examplesMatched += 1;
      }
    }
  }

  return [...inferred.values()]
    .sort((left, right) => right.examplesMatched - left.examplesMatched
      || left.from.table.localeCompare(right.from.table))
    .slice(0, 12);
}

function identifierPath(path) {
  return /(^|[@_:])(id|identifier|about)(?:__\$text)?$/i.test(path);
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
  const end = Math.min(offset + limit, leaves.length);
  const values = [];
  for (let index = offset; index < end; index += 1) {
    const leaf = leaves.get(index);
    values.push(`(${[
      leaf.id,
      leaf.parent_id,
      leaf.name,
      leaf.path,
      leaf.data_type,
      scalarValue(leaf.value),
    ].map(sqlLiteral).join(", ")})`);
  }
  const nextOffset = end;
  return {
    sql: values.length
      ? `INSERT INTO nodes (id, parent_id, name, path, data_type, value) VALUES\n${values.join(",\n")};`
      : "",
    nextOffset,
    total: leaves.length,
    done: nextOffset >= leaves.length,
  };
}

function postgresCopyBatch(offset, limit) {
  const copy = postgresCopyText(offset, limit);
  return {
    data: copy.text,
    nextOffset: copy.nextOffset,
    total: copy.total,
    done: copy.done,
  };
}

function postgresCopyBuffer(offset, limit) {
  const copy = postgresCopyText(offset, limit);
  const encoded = new TextEncoder().encode(copy.text);
  return {
    buffer: encoded.buffer,
    nextOffset: copy.nextOffset,
    total: copy.total,
    done: copy.done,
  };
}

function postgresCopyText(offset, limit) {
  const end = Math.min(offset + limit, leaves.length);
  const rows = [];
  for (let index = offset; index < end; index += 1) {
    const leaf = leaves.get(index, true);
    rows.push([
      leaf.id,
      leaf.parent_id,
      leaf.name,
      leaf.path,
      leaf.data_type,
      leaf.value,
    ].map(copyTextValue).join("\t"));
  }
  const nextOffset = end;
  return {
    text: rows.length ? `${rows.join("\n")}\n` : "",
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
  const text = String(value).replaceAll("\0", "\uFFFD");
  let escaped = "";
  for (const character of text) {
    const code = character.codePointAt(0);
    if (character === "'") escaped += "''";
    else if (character === "\\") escaped += "\\\\";
    else if (character === "\b") escaped += "\\b";
    else if (character === "\f") escaped += "\\f";
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (code < 32 || code === 127) escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    else escaped += character;
  }
  return `E'${escaped}'`;
}

function copyTextValue(value) {
  if (value === null || value === undefined) return "\\N";
  const text = String(value).replaceAll("\0", "\uFFFD");
  let escaped = "";
  for (const character of text) {
    const code = character.codePointAt(0);
    if (character === "\\") escaped += "\\\\";
    else if (character === "\b") escaped += "\\b";
    else if (character === "\f") escaped += "\\f";
    else if (character === "\n") escaped += "\\n";
    else if (character === "\r") escaped += "\\r";
    else if (character === "\t") escaped += "\\t";
    else if (character === "\v") escaped += "\\v";
    else if (code < 32 || code === 127) escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    else escaped += character;
  }
  return escaped;
}
