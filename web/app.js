import initJson2Leaf, { mapJson } from "./pkg/json2leaf.js";
import { buildCatalog, buildSql, preview } from "./query-planner.js";

const elements = {
  engineState: document.querySelector("#engine-state"),
  fileInput: document.querySelector("#file-input"),
  sampleButton: document.querySelector("#sample-button"),
  documentStatus: document.querySelector("#document-status"),
  tableList: document.querySelector("#table-list"),
  tableCount: document.querySelector("#table-count"),
  tableSelect: document.querySelector("#table-select"),
  operationSelect: document.querySelector("#operation-select"),
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

const state = {
  source: "sample_report",
  leaves: [],
  catalog: [],
  plan: {
    table: "",
    operation: "rows",
    fields: [],
    filter: { field: "", operator: "equals", value: "" },
  },
};

await initJson2Leaf();
elements.engineState.classList.add("ready");
elements.engineState.querySelector("strong").textContent = "Mapper ready in this browser";
await loadSample();

elements.sampleButton.addEventListener("click", loadSample);
elements.fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const input = JSON.parse(await file.text());
    const source = file.name.replace(/\.json$/i, "") || "document";
    loadDocument(source, input);
    elements.documentStatus.textContent = `${file.name} is ready to explore.`;
  } catch (error) {
    elements.documentStatus.textContent = `Choose valid JSON. ${error.message}`;
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

async function loadSample() {
  const response = await fetch("./sample.json");
  const input = await response.json();
  loadDocument("sample_report", input);
  elements.documentStatus.textContent = "The sample report is ready to explore.";
}

function loadDocument(source, input) {
  state.source = source;
  state.leaves = JSON.parse(mapJson(source, JSON.stringify(input)));
  state.catalog = buildCatalog(state.leaves);
  state.plan.table = state.catalog[0]?.name || "";
  state.plan.fields = state.catalog[0]?.fields.map((field) => field.name) || [];
  state.plan.filter = { field: "", operator: "equals", value: "" };
  renderSchema();
  renderPlanner();
  elements.documentStatus.textContent = `${state.catalog.length} tables and ${valueCount()} values are ready.`;
}

function renderSchema() {
  elements.tableCount.textContent = state.catalog.length;
  elements.tableList.replaceChildren();
  elements.tableSelect.replaceChildren();

  for (const table of state.catalog) {
    const item = elements.tableTemplate.content.firstElementChild.cloneNode(true);
    item.classList.toggle("active", table.name === state.plan.table);
    item.querySelector("strong").textContent = friendlyName(table.name);
    item.querySelector("small").textContent = `${table.fields.length} fields · ${table.rowCount} rows`;
    item.addEventListener("click", () => selectTable(table.name));
    elements.tableList.append(item);

    const option = new Option(friendlyName(table.name), table.name);
    option.selected = table.name === state.plan.table;
    elements.tableSelect.add(option);
  }
}

function selectTable(name) {
  const table = state.catalog.find((item) => item.name === name);
  if (!table) return;
  state.plan.table = name;
  state.plan.fields = table.fields.map((field) => field.name);
  state.plan.filter = { field: "", operator: "equals", value: "" };
  elements.filterValue.value = "";
  renderSchema();
  renderPlanner();
}

function renderPlanner() {
  const table = state.catalog.find((item) => item.name === state.plan.table);
  elements.operationSelect.value = state.plan.operation;
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
        : state.plan.fields.filter((name) => name !== field.name);
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

function updateSql() {
  elements.sqlOutput.textContent = buildSql(state.plan, state.catalog);
}

function renderResult() {
  const result = preview(state.plan, state.leaves, state.catalog);
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

function valueCount() {
  return state.leaves.filter((leaf) => leaf.name !== "_tree").length;
}

function friendlyName(value) {
  return String(value).split("__").at(-1).replaceAll("_", " ");
}

function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
