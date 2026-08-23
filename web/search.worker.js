import initJson2Leaf, { TrigramIndex } from "./pkg/json2leaf.js?v=20260823-5";

const wasmReady = initializeWasm();

let index = null;
let size = 0;

self.addEventListener("message", async ({ data }) => {
  const { id, operation } = data;
  try {
    await wasmReady;
    let result;
    if (operation === "load") {
      index?.free();
      index = new TrigramIndex();
      size = data.catalog.length;
      for (const table of data.catalog) {
        const text = [
          table.name,
          friendlyName(table.name),
          ...table.fields.flatMap((field) => [field.name, friendlyName(field.name)]),
        ].join(" ");
        index.add(table.name, text);
      }
      result = size;
    } else if (operation === "search") {
      result = data.query.trim() && index ? JSON.parse(index.search(data.query, size)) : [];
    } else {
      throw new Error(`Unknown search operation: ${operation}`);
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});

function friendlyName(value) {
  return String(value).split("__").at(-1).replaceAll("_", " ");
}

async function initializeWasm() {
  if (globalThis.process?.versions?.node) {
    const { readFile } = await import("node:fs/promises");
    const module = await readFile(new URL("./pkg/json2leaf_bg.wasm", import.meta.url));
    await initJson2Leaf({ module_or_path: module });
    return;
  }
  await initJson2Leaf({
    module_or_path: new URL("./pkg/json2leaf_bg.wasm?v=20260823-5", import.meta.url),
  });
}
