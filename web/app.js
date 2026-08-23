const elements = {
  engineState: document.querySelector("#engine-state"),
  fileInput: document.querySelector("#file-input"),
  reactomeButton: document.querySelector("#reactome-button"),
  documentStatus: document.querySelector("#document-status"),
  documentPrep: document.querySelector("#document-prep"),
  prepStages: document.querySelector("#prep-stages"),
  workspace: document.querySelector("#workspace"),
  tableList: document.querySelector("#table-list"),
  tableCount: document.querySelector("#table-count"),
  tableSearch: document.querySelector("#table-search"),
  tableSelect: document.querySelector("#table-select"),
  operationSelect: document.querySelector("#operation-select"),
  queryPrompt: document.querySelector("#query-prompt"),
  fieldPicker: document.querySelector("#field-picker"),
  filterBlock: document.querySelector("#filter-block"),
  fieldOptions: document.querySelector("#field-options"),
  filterField: document.querySelector("#filter-field"),
  filterOperator: document.querySelector("#filter-operator"),
  filterValue: document.querySelector("#filter-value"),
  clearFilter: document.querySelector("#clear-filter"),
  runButton: document.querySelector("#run-button"),
  copyButton: document.querySelector("#copy-button"),
  sqlOutput: document.querySelector("#sql-output"),
  resultWrap: document.querySelector("#result-wrap"),
  rowCount: document.querySelector("#row-count"),
  tableTemplate: document.querySelector("#table-template"),
};

function WorkerClient(path) {
  this.worker = new Worker(`${path}?v=20260823-5`, { type: "module" });
  this.nextId = 0;
  this.pending = new Map();
  this.worker.addEventListener("message", ({ data }) => {
    const request = this.pending.get(data.id);
    if (!request) return;
    this.pending.delete(data.id);
    window.clearTimeout(request.timer);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  });
  this.worker.addEventListener("error", (error) => {
    for (const request of this.pending.values()) {
      window.clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  });
}

WorkerClient.prototype.call = function call(operation, payload = {}, transfer = []) {
  const id = ++this.nextId;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`${operation} took longer than two minutes.`));
    }, 120_000);
    this.pending.set(id, { resolve, reject, timer });
    this.worker.postMessage({ id, operation, ...payload }, transfer);
  });
};

const state = {
  catalog: [],
  visibleTables: [],
  searchVersion: 0,
  plan: {
    table: "",
    operation: "rows",
    fields: [],
    filter: { field: "", operator: "equals", value: "" },
  },
};

const mapper = new WorkerClient("./mapper.worker.js");
const dataStore = new WorkerClient("./data.worker.js");
const search = new WorkerClient("./search.worker.js");

await mapper.call("ready");
elements.engineState.classList.add("ready");
elements.engineState.querySelector("strong").textContent = "Ready in this browser";
await loadReactomeSample();

elements.reactomeButton.addEventListener("click", loadReactomeSample);
elements.tableSearch.addEventListener("input", searchTables);
elements.fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  const source = file.name.replace(/\.(json|xml)$/i, "") || "document";
  const format = file.name.toLowerCase().endsWith(".xml") || file.type.includes("xml")
    ? "xml"
    : "json";
  setPreparation("read", `Reading ${file.name}…`);
  try {
    await openDocument(source, await file.arrayBuffer(), format, file.name);
  } catch (error) {
    showPreparationError(error);
  }
});

elements.tableSelect.addEventListener("change", () => selectTable(elements.tableSelect.value));
elements.operationSelect.addEventListener("change", () => {
  state.plan.operation = elements.operationSelect.value;
  renderPlanner();
});
elements.filterField.addEventListener("change", updateFilter);
elements.filterOperator.addEventListener("change", updateFilter);
elements.filterValue.addEventListener("input", updateFilter);
elements.clearFilter.addEventListener("click", () => {
  elements.filterField.value = "";
  elements.filterValue.value = "";
  updateFilter();
});
elements.runButton.addEventListener("click", renderResult);
elements.copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.sqlOutput.textContent);
  elements.copyButton.textContent = "Copied";
  window.setTimeout(() => { elements.copyButton.textContent = "Copy SQL"; }, 1400);
});

async function loadReactomeSample() {
  setPreparation("read", "Reading 30 MB of Reactome pathways…");
  try {
    const response = await fetch("./samples/reactome-pathways.xml");
    if (!response.ok) throw new Error("Folio could not read the Reactome pathways.");
    await openDocument(
      "reactome_pathways",
      await response.arrayBuffer(),
      "xml",
      "Reactome BioPAX",
    );
  } catch (error) {
    showPreparationError(error);
  }
}

async function openDocument(source, buffer, format, label) {
  setPreparation("map", "Mapping the document structure…");
  const mapped = await mapper.call("map", { source, format, buffer }, [buffer]);
  setPreparation("catalog", "Building queryable tables…");
  const result = await dataStore.call("load", { buffer: mapped }, [mapped]);
  state.catalog = result.catalog;
  state.visibleTables = state.catalog;
  const pathwayTable = state.catalog.find(
    (table) => table.name === "reactome_pathways__bp:pathway",
  );
  const table = pathwayTable || state.catalog[0];
  state.plan.table = table?.name || "";
  state.plan.fields = table?.fields.map((field) => field.name) || [];
  state.plan.operation = configureRelationshipReport(Boolean(pathwayTable));
  state.plan.filter = { field: "", operator: "equals", value: "" };
  elements.tableSearch.value = "";
  setPreparation("index", "Indexing elements and fields…");
  await search.call("load", { catalog: state.catalog });
  renderSchema();
  renderPlanner();
  await renderResult();
  setPreparation(
    "ready",
    `${label} has ${state.catalog.length} tables and ${result.valueCount} values.`,
  );
}

function configureRelationshipReport(available) {
  elements.operationSelect.querySelector('[value="pathway-components"]')?.remove();
  if (!available) return "rows";
  elements.operationSelect.add(new Option(
    "Components of Programmed Cell Death",
    "pathway-components",
  ));
  return "pathway-components";
}

function setPreparation(stage, message) {
  const order = ["read", "map", "catalog", "index"];
  const activeIndex = stage === "ready" ? order.length : order.indexOf(stage);
  for (const item of elements.prepStages.children) {
    const itemIndex = order.indexOf(item.dataset.stage);
    item.classList.toggle("complete", itemIndex < activeIndex || stage === "ready");
    item.classList.toggle("active", itemIndex === activeIndex);
    item.classList.remove("error");
    if (itemIndex === activeIndex) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
  const busy = stage !== "ready";
  elements.documentPrep.setAttribute("aria-busy", String(busy));
  elements.workspace.setAttribute("aria-busy", String(busy));
  elements.documentStatus.textContent = message;
}

function showPreparationError(error) {
  const active = elements.prepStages.querySelector(".active");
  active?.classList.add("error");
  elements.documentPrep.setAttribute("aria-busy", "false");
  elements.workspace.setAttribute("aria-busy", "false");
  elements.documentStatus.textContent = `Review this document's JSON or XML syntax. ${error.message}`;
}

async function searchTables() {
  const query = elements.tableSearch.value;
  const version = ++state.searchVersion;
  const matches = query.trim() ? await search.call("search", { query }) : [];
  if (version !== state.searchVersion) return;
  const tablesByName = new Map(state.catalog.map((table) => [table.name, table]));
  state.visibleTables = query.trim()
    ? matches.map((result) => tablesByName.get(result.id)).filter(Boolean)
    : state.catalog;
  const first = state.visibleTables[0];
  const currentIsVisible = state.visibleTables.some((table) => table.name === state.plan.table);
  if (query.trim() && first && !currentIsVisible) {
    selectTable(first.name);
    return;
  }
  renderSchema();
}

function renderSchema() {
  const searching = elements.tableSearch.value.trim();
  elements.tableCount.textContent = searching
    ? `${state.visibleTables.length}/${state.catalog.length}`
    : state.catalog.length;
  elements.tableList.replaceChildren();
  elements.tableSelect.replaceChildren();

  for (const table of state.visibleTables) {
    const item = elements.tableTemplate.content.firstElementChild.cloneNode(true);
    item.classList.toggle("active", table.name === state.plan.table);
    item.querySelector("strong").textContent = friendlyName(table.name);
    item.querySelector("small").textContent = `${table.fields.length} fields · ${table.rowCount} rows`;
    item.addEventListener("click", () => selectTable(table.name));
    elements.tableList.append(item);
  }

  if (!state.visibleTables.length) {
    const message = document.createElement("p");
    message.className = "empty-table-search";
    message.textContent = "Try another element or field name.";
    elements.tableList.append(message);
  }

  for (const table of state.catalog) {
    const option = new Option(friendlyName(table.name), table.name);
    option.selected = table.name === state.plan.table;
    elements.tableSelect.add(option);
  }
}

function selectTable(name) {
  const table = state.catalog.find((item) => item.name === name);
  if (!table) return;
  state.plan.table = name;
  if (state.plan.operation === "pathway-components") state.plan.operation = "rows";
  state.plan.fields = table.fields.map((field) => field.name);
  state.plan.filter = { field: "", operator: "equals", value: "" };
  elements.filterValue.value = "";
  renderSchema();
  renderPlanner();
}

function renderPlanner() {
  const table = state.catalog.find((item) => item.name === state.plan.table);
  const relationshipReport = state.plan.operation === "pathway-components";
  elements.operationSelect.value = state.plan.operation;
  elements.queryPrompt.hidden = !relationshipReport;
  elements.queryPrompt.textContent = relationshipReport
    ? "Which pathways are direct components of Programmed Cell Death?"
    : "";
  elements.fieldPicker.hidden = relationshipReport;
  elements.filterBlock.hidden = relationshipReport;
  elements.fieldOptions.replaceChildren();
  elements.filterField.replaceChildren(new Option("Choose a field", ""));

  for (const field of table?.fields || []) {
    const label = document.createElement("label");
    label.className = "field-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = field.name;
    input.checked = state.plan.fields.includes(field.name);
    input.addEventListener("change", () => {
      state.plan.fields = input.checked
        ? [...state.plan.fields, field.name]
        : state.plan.fields.filter((fieldName) => fieldName !== field.name);
      updateSql();
    });
    const pill = document.createElement("span");
    const dot = document.createElement("i");
    dot.className = `type-dot ${field.type}`;
    pill.append(dot, field.name);
    label.append(input, pill);
    elements.fieldOptions.append(label);
    elements.filterField.add(new Option(friendlyName(field.name), field.name));
  }

  elements.filterField.value = state.plan.filter.field;
  elements.filterOperator.value = state.plan.filter.operator;
  elements.filterValue.value = state.plan.filter.value;
  updateSql();
}

function updateFilter() {
  state.plan.filter = {
    field: elements.filterField.value,
    operator: elements.filterOperator.value,
    value: elements.filterValue.value,
  };
  updateSql();
}

async function updateSql() {
  elements.sqlOutput.textContent = await dataStore.call("sql", { plan: state.plan });
}

async function renderResult() {
  const result = await dataStore.call("preview", { plan: state.plan });
  elements.rowCount.textContent = `${result.rows.length} ${result.rows.length === 1 ? "row" : "rows"}`;
  if (!result.rows.length) {
    elements.resultWrap.innerHTML = `
      <div class="empty-result">
        <span aria-hidden="true">◇</span>
        <p>This query returned zero rows. Adjust the filter and run it again.</p>
      </div>`;
    return;
  }

  const table = document.createElement("table");
  table.className = "result-table";
  const head = table.createTHead().insertRow();
  for (const column of result.columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = friendlyName(column);
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of result.rows) {
    const line = body.insertRow();
    for (const column of result.columns) {
      const cell = line.insertCell();
      cell.textContent = formatValue(row[column]);
      cell.title = cell.textContent;
    }
  }
  elements.resultWrap.replaceChildren(table);
}

function friendlyName(value) {
  return String(value).split("__").at(-1).replaceAll("_", " ");
}

function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
