import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { buildSystemPrompt, validateReadQuery } from "./assistant-context.js";
import { buildCatalog, buildSql } from "./query-planner.js";
import { SCHEMA_STARTER_QUERIES } from "./schema-queries.js";
import { expectedArtistOverview, recursiveQueryLeaves } from "../tests/query-fixtures.mjs";

import { normalizeSingleUserInput } from "./vendor/pgrust/format.js";
import { run, Vfs } from "./vendor/pgrust/pgrust-wasi.js";
import { parseMessage } from "./vendor/pgrust/wire.js";
import { WireSession } from "./vendor/pgrust/wiresession.js";

const workerHarness = new URL("./node-worker-harness.mjs", import.meta.url);
const postgresAssets = new URL("./vendor/pgrust/assets/", import.meta.url);

test("document rows load into PostgreSQL and produce a result", { timeout: 120_000 }, async (context) => {
  const data = workerClient("./data.worker.js");
  context.after(() => data.close());

  const leaves = [
    {
      id: "evidence-132",
      parent_id: "document",
      name: "report__evidence",
      path: "comment",
      data_type: "string",
      value: "ATG7 activates ATG12.\n\nIt's transferred to ATG10.\\source\tverified",
    },
  ];
  const encoded = new TextEncoder().encode(JSON.stringify(leaves));
  const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  await data.call("load", { buffer }, [buffer]);

  const [wasmBytes, imageBytes, manifestText] = await Promise.all([
    readFile(new URL("postgres.wasm", postgresAssets)),
    readFile(new URL("vfs.img", postgresAssets)),
    readFile(new URL("vfs.json", postgresAssets), "utf8"),
  ]);
  const wasmModule = await WebAssembly.compile(wasmBytes);
  const image = new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength);
  const database = postgresRunner(wasmModule, image, JSON.parse(manifestText));

  await database.exec(await data.call("postgresSchema"));
  const batch = await data.call("postgresBatch", { offset: 0, limit: 10 });
  await database.exec(batch.sql);
  await database.exec(await data.call("postgresIndexes"));
  const output = await database.exec(`
    SELECT
      count(*) AS rows,
      bool_and(position(E'\\n' in value) > 0) AS has_newline,
      bool_and(position(E'It''s' in value) > 0) AS has_apostrophe
    FROM nodes
    WHERE name = 'report__evidence';
  `);

  assert.match(output, /rows = "1"/);
  assert.match(output, /has_newline = "t"/);
  assert.match(output, /has_apostrophe = "t"/);
});

test("COPY streams document rows through PostgreSQL wire mode", { timeout: 120_000 }, async (context) => {
  const data = workerClient("./data.worker.js");
  context.after(() => data.close());

  const leaves = [
    {
      id: "release-1",
      parent_id: "catalog",
      name: "catalog__release",
      path: "title",
      data_type: "string",
      value: "It's music\nwith a second line\\master\tverified",
    },
    {
      id: "release-2",
      parent_id: null,
      name: "catalog__release",
      path: "genre",
      data_type: "string",
      value: "Electronic",
    },
  ];
  const encoded = new TextEncoder().encode(JSON.stringify(leaves));
  const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  await data.call("load", { buffer }, [buffer]);
  const copyBatch = await data.call("postgresCopyBatch", { offset: 0, limit: 50_000 });
  const copyBuffer = await data.call("postgresCopyBuffer", { offset: 0, limit: 50_000 });
  assert.equal(new TextDecoder().decode(copyBuffer.buffer), copyBatch.data);

  const [wasmBytes, imageBytes, manifestText] = await Promise.all([
    readFile(new URL("postgres.wasm", postgresAssets)),
    readFile(new URL("vfs.img", postgresAssets)),
    readFile(new URL("vfs.json", postgresAssets), "utf8"),
  ]);
  const session = new WireSession({
    wasmModule: await WebAssembly.compile(wasmBytes),
    vfs: new Vfs(
      new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength),
      JSON.parse(manifestText),
    ),
  });
  context.after(() => session.terminate());

  await session.start();
  assertWireSuccess(await session.query(await data.call("postgresSchema")));
  const copied = assertWireSuccess(await session.copyFromStdin(
    "COPY nodes (id, parent_id, name, path, data_type, value) FROM STDIN WITH (FORMAT text);",
    [copyBatch.data],
  ));
  assert.equal(copied.find((message) => message.t === "C")?.parsed.tag, "COPY 2");

  const selected = assertWireSuccess(await session.query(`
    SELECT id, parent_id, value
    FROM nodes
    ORDER BY id;
  `));
  const rows = selected
    .filter((message) => message.t === "D")
    .map((message) => message.parsed.values);
  assert.deepEqual(rows, [
    ["release-1", "catalog", "It's music\nwith a second line\\master\tverified"],
    ["release-2", null, "Electronic"],
  ]);
});

test("recursive UI queries execute across multiple levels in PostgreSQL", { timeout: 120_000 }, async (context) => {
  const data = workerClient("./data.worker.js");
  context.after(() => data.close());
  const leaves = recursiveQueryLeaves();
  const buffer = new TextEncoder().encode(JSON.stringify(leaves)).buffer;
  const prepared = await data.call("load", { buffer }, [buffer]);
  const session = await openTestDatabase(context, data, prepared.leafCount);
  const query = async (sql) => wireRows(await session.query(validateReadQuery(sql)));

  const indexes = wireRows(await session.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'nodes';"));
  assert.equal(indexes.length, 3);
  assert.ok(indexes.every((row) => row.indexdef.includes("USING btree")));
  assert.ok(indexes.some((row) => row.indexdef.includes("(parent_id)")));

  for (const [name, sql] of Object.entries(SCHEMA_STARTER_QUERIES)) {
    const rows = await query(sql);
    assert.ok(rows.length > 0, name);
    if (name === "relationships") {
      assert.deepEqual(rows.find((row) => row.ancestor_type === "document"
        && row.descendant_type === "document__items__children" && row.depth === "3"), {
        ancestor_type: "document", descendant_type: "document__items__children", depth: "3", links: "1",
      });
      assert.equal(rows.find((row) => row.ancestor_type === "document__items"
        && row.descendant_type === "document__items__children" && row.depth === "2").links, "1");
    }
  }

  const catalog = buildCatalog(leaves);
  const plan = { table: "document__items", fields: ["name", "amount"], filter: {} };
  for (const [operation, expected] of [["count", { row_count: "2" }], ["sum", { total: "205.5" }], ["average", { average: "102.75" }]]) {
    const [row] = await query(buildSql({ ...plan, operation }, catalog));
    for (const key of Object.keys(expected)) assert.equal(Number(row[key]), Number(expected[key]), operation);
  }
  const rowReport = await query(buildSql({ ...plan, operation: "rows" }, catalog));
  assert.deepEqual(rowReport.map((row) => row.name).sort(), ["First", "Second"]);
  const tree = await query(buildSql({ operation: "tree" }, catalog));
  assert.equal(tree.length, leaves.filter((leaf) => leaf.name === "_tree").length);
  assert.equal(tree.find((row) => row.id === "child-1").depth, "3");
  const artists = await query(buildSql({ operation: "discogs-artist-overview" }, catalog));
  assert.deepEqual(normalizeArtists(artists), expectedArtistOverview);

  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  const guide = html.split('<div class="schema-examples">')[1].split("</section>")[0];
  const examples = [...guide.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((match) => match[1]);
  assert.equal(examples.length, 2);
  for (const sql of examples) {
    assert.match(sql, /^WITH RECURSIVE/);
    assert.ok((await query(sql)).length > 0);
  }
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const readmeTree = readme.match(/```sql\n(WITH RECURSIVE[\s\S]*?)\n```/)?.[1];
  assert.ok(readmeTree);
  assert.equal((await query(readmeTree)).length, tree.length);

  const prompt = buildSystemPrompt({
    tables: [
      { name: "document__items", fields: ["name:string"] },
      { name: "document__items__children", fields: ["name:string"] },
    ],
    relationships: [{ type: "contains", parent: "document__items", child: "document__items__children" }],
  });
  const pattern = prompt.match(/WITH RECURSIVE parent_record AS \([\s\S]*?LIMIT 100;/)?.[0];
  assert.ok(pattern);
  assert.deepEqual((await query(pattern)).sort((a, b) => a.parent_value.localeCompare(b.parent_value)), [
    { parent_value: "First", child_value: "Deep child" },
    { parent_value: "Second", child_value: "Direct child" },
  ]);
});

test("recursive Discogs report runs against the complete 30 MB XML demo", { timeout: 180_000 }, async (context) => {
  const mapper = workerClient("./mapper.worker.js");
  const data = workerClient("./data.worker.js");
  context.after(() => Promise.all([mapper.close(), data.close()]));
  const input = await readFile(new URL("./samples/discogs-releases.xml", import.meta.url));
  const source = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  const mapped = await mapper.call("map", { source: "discogs_releases", format: "xml", buffer: source }, [source]);
  const prepared = await data.call("load", { buffer: mapped }, [mapped]);
  const session = await openTestDatabase(context, data, prepared.leafCount);
  const plan = { operation: "discogs-artist-overview" };
  const sql = await data.call("sql", { plan });
  assert.match(sql, /^WITH RECURSIVE/);
  validateReadQuery(sql);
  const started = performance.now();
  const rows = normalizeArtists(wireRows(await session.query(sql)));
  context.diagnostic(`${prepared.leafCount} mapped rows; recursive report ${(performance.now() - started).toFixed(0)} ms`);
  assert.equal(rows.length, 25);
  const preview = await data.call("preview", { plan });
  assert.deepEqual(rows, preview.rows);

  const explain = wireRows(await session.query(`EXPLAIN ${sql}`)).map((row) => row["QUERY PLAN"]).join("\n");
  assert.match(explain, /Recursive Union/);
  const usedIndexes = [...new Set(explain.match(/nodes_\w+_idx/g))];
  context.diagnostic(`Report indexes: ${usedIndexes.join(", ")}`);
  assert.ok(usedIndexes.length > 0);
  const relationshipRows = wireRows(await session.query(SCHEMA_STARTER_QUERIES.relationships));
  assert.ok(relationshipRows.some((row) => Number(row.depth) > 1));
});

function normalizeArtists(rows) {
  return rows.map((row) => ({ ...row,
    release_count: Number(row.release_count), track_count: Number(row.track_count), label_count: Number(row.label_count),
  }));
}

async function openTestDatabase(context, data, leafCount) {
  const [wasmBytes, imageBytes, manifestText] = await Promise.all([
    readFile(new URL("postgres.wasm", postgresAssets)),
    readFile(new URL("vfs.img", postgresAssets)),
    readFile(new URL("vfs.json", postgresAssets), "utf8"),
  ]);
  const session = new WireSession({
    wasmModule: await WebAssembly.compile(wasmBytes),
    vfs: new Vfs(new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength), JSON.parse(manifestText)),
  });
  context.after(() => session.terminate());
  await session.start();
  assertWireSuccess(await session.query(await data.call("postgresSchema")));
  for (let offset = 0; offset < leafCount; offset += 50_000) {
    const batch = await data.call("postgresCopyBatch", { offset, limit: 50_000 });
    assertWireSuccess(await session.copyFromStdin(
      "COPY nodes (id, parent_id, name, path, data_type, value) FROM STDIN WITH (FORMAT text);",
      [batch.data],
    ));
  }
  assertWireSuccess(await session.query(await data.call("postgresIndexes")));
  return session;
}

function wireRows(messages) {
  const parsed = assertWireSuccess(messages);
  const fields = parsed.find((message) => message.t === "T")?.parsed.columns.map((field) => field.name) || [];
  return parsed.filter((message) => message.t === "D")
    .map((message) => Object.fromEntries(fields.map((field, index) => [field, message.parsed.values[index]])));
}

function assertWireSuccess(messages) {
  const parsed = messages.map((message) => ({
    ...message,
    parsed: parseMessage(message.t, message.body),
  }));
  const error = parsed.find((message) => message.t === "E");
  assert.equal(error, undefined, error?.parsed.message);
  return parsed;
}

function postgresRunner(wasmModule, image, manifest) {
  const vfs = new Vfs(image, manifest);
  return {
    async exec(sql) {
      const stdout = [];
      const stderr = [];
      const result = await run({
        wasmModule,
        vfs,
        stdinBytes: new TextEncoder().encode(normalizeSingleUserInput(sql)),
        onStdout: (bytes) => stdout.push(Buffer.from(bytes)),
        onStderr: (bytes) => stderr.push(Buffer.from(bytes)),
      });
      const output = Buffer.concat(stdout).toString("utf8");
      const diagnostics = Buffer.concat(stderr).toString("utf8");
      assert.equal(result.exitCode, 0, diagnostics);
      assert.doesNotMatch(diagnostics, /(?:ERROR|FATAL|PANIC):/, diagnostics);
      return output;
    },
  };
}

function workerClient(modulePath) {
  const worker = new Worker(workerHarness, {
    type: "module",
    workerData: { module: new URL(modulePath, import.meta.url).href },
  });
  const pending = new Map();
  let nextId = 0;

  worker.on("message", (message) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  worker.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  return {
    call(operation, payload = {}, transfer = []) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, operation, ...payload }, transfer);
      });
    },
    close() {
      return worker.terminate();
    },
  };
}
