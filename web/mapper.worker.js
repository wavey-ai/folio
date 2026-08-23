import initJson2Leaf, { mapJson, mapXml } from "./pkg/json2leaf.js?v=20260823-5";

const wasmReady = initializeWasm();

self.addEventListener("message", async ({ data }) => {
  const { id, operation } = data;
  try {
    await wasmReady;
    if (operation === "ready") {
      self.postMessage({ id, result: true });
      return;
    }

    if (operation !== "map") throw new Error(`Unknown mapper operation: ${operation}`);
    const input = new TextDecoder().decode(data.buffer);
    const output = data.format === "xml"
      ? mapXml(data.source, input)
      : mapJson(data.source, input);
    const encoded = new TextEncoder().encode(output);
    self.postMessage({ id, result: encoded.buffer }, [encoded.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});

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
