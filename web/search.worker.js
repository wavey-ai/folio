import initJson2Leaf, { TrigramIndex } from "./pkg/json2leaf.js?v=20260823-5";

const wasmReady = initializeWasm();

let index = null;
let contextIndex = null;
let size = 0;

self.addEventListener("message", async ({ data }) => {
  const { id, operation } = data;
  try {
    await wasmReady;
    let result;
    if (operation === "load") {
      index?.free();
      contextIndex?.free();
      index = new TrigramIndex();
      contextIndex = new TrigramIndex();
      size = data.catalog.length;
      for (const table of data.catalog) {
        const text = [
          table.name,
          friendlyName(table.name),
          ...table.fields.flatMap((field) => [field.name, friendlyName(field.name)]),
        ].join(" ");
        index.add(table.name, text);
        const localName = table.name.split("__").at(-1);
        contextIndex.add(table.name, [
          localName,
          friendlyName(localName),
          ...table.fields.flatMap((field) => [field.name, friendlyName(field.name)]),
        ].join(" "));
      }
      result = size;
    } else if (operation === "search") {
      result = data.query.trim() && index ? JSON.parse(index.search(data.query, size)) : [];
    } else if (operation === "contextSearch") {
      result = searchContext(data.query);
    } else {
      throw new Error(`Unknown search operation: ${operation}`);
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});

function searchContext(query) {
  if (!contextIndex) return [];
  const terms = contextTerms(query);
  const firstMatches = [];
  const combined = new Map();

  for (const term of terms) {
    const matches = JSON.parse(contextIndex.search(term, Math.min(size, 6)));
    if (matches[0] && !firstMatches.some((match) => match.id === matches[0].id)) {
      firstMatches.push(matches[0]);
    }
    for (const match of matches) {
      combined.set(match.id, (combined.get(match.id) || 0) + match.score);
    }
  }

  const ranked = [...combined]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return [...firstMatches, ...ranked.filter(
    (match) => !firstMatches.some((first) => first.id === match.id),
  )].slice(0, 12);
}

function contextTerms(query) {
  const ignored = new Set([
    "about", "across", "after", "before", "count", "distinct", "each", "found",
    "from", "greatest", "least", "many", "most", "name", "number", "report",
    "show", "sort", "than", "that", "their", "these", "this", "which", "with",
  ]);
  return [...new Set(String(query)
    .toLowerCase()
    .split(/[^a-z0-9@:$]+/)
    .map((term) => term.length > 4 && term.endsWith("s") ? term.slice(0, -1) : term)
    .filter((term) => term.length >= 4 && !ignored.has(term)))]
    .slice(0, 10);
}

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
