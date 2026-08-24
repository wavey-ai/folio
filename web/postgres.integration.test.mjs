import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";

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
