import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";

const harness = new URL("./node-worker-harness.mjs", import.meta.url);

test("workers map, catalog, search, and query a document", async (context) => {
  const mapper = workerClient("./mapper.worker.js");
  const data = workerClient("./data.worker.js");
  const search = workerClient("./search.worker.js");
  context.after(async () => Promise.all([mapper.close(), data.close(), search.close()]));

  assert.equal(await mapper.call("ready"), true);
  const input = await readFile(new URL("../tests/fixtures/report.json", import.meta.url));
  const source = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  const mapped = await mapper.call(
    "map",
    { source: "report", format: "json", buffer: source },
    [source],
  );
  const prepared = await data.call("load", { buffer: mapped }, [mapped]);

  assert.ok(prepared.catalog.length > 0);
  assert.ok(prepared.valueCount > 0);
  assert.equal(await search.call("load", { catalog: prepared.catalog }), prepared.catalog.length);

  const table = prepared.catalog.find((item) => item.fields.some((field) => field.name === "amount"));
  assert.ok(table);
  const matches = await search.call("search", { query: "ammount" });
  assert.ok(matches.some((match) => match.id === table.name));

  const plan = {
    table: table.name,
    operation: "rows",
    fields: table.fields.map((field) => field.name),
    filter: { field: "", operator: "equals", value: "" },
  };
  assert.match(await data.call("sql", { plan }), /SELECT/);
  const result = await data.call("preview", { plan });
  assert.ok(result.columns.includes("amount"));
  assert.ok(result.rows.length > 0);
});

function workerClient(modulePath) {
  const worker = new Worker(harness, {
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
