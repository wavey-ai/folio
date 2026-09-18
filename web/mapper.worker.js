import initJson2Leaf, {
  mapJsonCompact,
  mapXmlCompact,
} from "./pkg/json2leaf.js?v=20260823-6";
import { RUNTIME_ASSETS } from "./runtime-assets.js?v=20260823-2";
import { parseCsv } from "./csv.js?v=20260917-1";

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
    let input = new Uint8Array(data.buffer);
    if (data.format === "csv") {
      const records = parseCsv(new TextDecoder().decode(input));
      input = new TextEncoder().encode(JSON.stringify(records));
    }
    const output = data.format === "xml"
      ? mapXmlCompact(data.source, input)
      : mapJsonCompact(data.source, input);
    const buffer = output.byteOffset === 0 && output.byteLength === output.buffer.byteLength
      ? output.buffer
      : output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
    self.postMessage({ id, result: buffer }, [buffer]);
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
    module_or_path: RUNTIME_ASSETS.json2leafWasm,
  });
}
