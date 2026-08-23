import { buildCatalog, buildSql, preview } from "./query-planner.js";

let leaves = [];
let catalog = [];

self.addEventListener("message", ({ data }) => {
  const { id, operation } = data;
  try {
    let result;
    if (operation === "load") {
      leaves = JSON.parse(new TextDecoder().decode(data.buffer));
      catalog = buildCatalog(leaves);
      result = {
        catalog,
        valueCount: leaves.reduce((count, leaf) => count + Number(leaf.name !== "_tree"), 0),
      };
    } else if (operation === "sql") {
      result = buildSql(data.plan, catalog);
    } else if (operation === "preview") {
      result = preview(data.plan, leaves, catalog);
    } else {
      throw new Error(`Unknown data operation: ${operation}`);
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
});
