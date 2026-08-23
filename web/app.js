import { validateProposal, validateReadQuery } from "./assistant-context.js";
import { PgrustClient } from "./pgrust-client.js";

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
  modelLoader: document.querySelector("#model-loader"),
  modelStatus: document.querySelector("#model-status"),
  modelProgressCopy: document.querySelector("#model-progress-copy"),
  modelProgressBar: document.querySelector("#model-progress-bar"),
  modelLoadButton: document.querySelector("#model-load-button"),
  browserCheck: document.querySelector("#browser-check"),
  browserCheckTitle: document.querySelector("#browser-check-title"),
  browserCheckStatus: document.querySelector("#browser-check-status"),
  browserCheckGuidance: document.querySelector("#browser-check-guidance"),
  askForm: document.querySelector("#ask-form"),
  askInput: document.querySelector("#ask-input"),
  askButton: document.querySelector("#ask-button"),
  assistantFlow: document.querySelector("#assistant-flow"),
  assistantAnswer: document.querySelector("#assistant-answer"),
};

function WorkerClient(path, onEvent = () => {}) {
  this.worker = new Worker(`${path}?v=20260823-16`, { type: "module" });
  this.nextId = 0;
  this.pending = new Map();
  this.worker.addEventListener("message", ({ data }) => {
    if (data.id === undefined || data.id === null) {
      onEvent(data);
      return;
    }
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
  const longOperation = operation === "load" || operation === "ask" || operation === "repair";
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`${operation} took longer than ${longOperation ? "30 minutes" : "two minutes"}.`));
    }, longOperation ? 1_800_000 : 120_000);
    this.pending.set(id, { resolve, reject, timer });
    this.worker.postMessage({ id, operation, ...payload }, transfer);
  });
};

const state = {
  catalog: [],
  visibleTables: [],
  searchVersion: 0,
  documentGeneration: 0,
  postgresReadyGeneration: 0,
  postgresLoading: null,
  leafCount: 0,
  modelReady: false,
  modelLoading: null,
  assistantBusy: false,
  sqlSource: "wizard",
  sqlVersion: 0,
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
const llm = new WorkerClient("./llm.worker.js", handleModelEvent);
const capabilities = new WorkerClient("./capability.worker.js");
const postgres = new PgrustClient(handlePostgresEvent);

elements.modelLoadButton.addEventListener("click", () => {
  prepareModel().catch(() => {});
});
elements.askForm.addEventListener("submit", askFolio);
elements.sqlOutput.addEventListener("input", () => {
  state.sqlSource = "edited";
  state.sqlVersion += 1;
});
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
elements.runButton.addEventListener("click", runCurrentQuery);
elements.copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.sqlOutput.value);
  elements.copyButton.textContent = "Copied";
  window.setTimeout(() => { elements.copyButton.textContent = "Copy SQL"; }, 1400);
});

elements.askButton.disabled = true;
checkBrowser();
await mapper.call("ready");
elements.engineState.classList.add("ready");
elements.engineState.querySelector("strong").textContent = "Ready in this browser";
await loadReactomeSample();

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
  const generation = ++state.documentGeneration;
  state.postgresReadyGeneration = 0;
  state.postgresLoading = null;
  setPreparation("map", "Mapping the document structure…");
  const mapped = await mapper.call("map", { source, format, buffer }, [buffer]);
  if (generation !== state.documentGeneration) return;
  setPreparation("catalog", "Building queryable tables…");
  const result = await dataStore.call("load", { buffer: mapped, label }, [mapped]);
  if (generation !== state.documentGeneration) return;
  state.catalog = result.catalog;
  state.leafCount = result.leafCount;
  state.visibleTables = state.catalog;
  const pathwayTable = state.catalog.find(
    (table) => table.name === "reactome_pathways__bp:pathway",
  );
  const table = pathwayTable || state.catalog[0];
  state.plan.table = table?.name || "";
  state.plan.fields = table?.fields.map((field) => field.name) || [];
  state.plan.operation = configureRelationshipReport(Boolean(pathwayTable));
  state.plan.filter = { field: "", operator: "equals", value: "" };
  state.sqlSource = "wizard";
  elements.tableSearch.value = "";
  setPreparation("index", "Indexing elements and fields…");
  await search.call("load", { catalog: state.catalog });
  if (generation !== state.documentGeneration) return;
  renderSchema();
  renderPlanner();
  await renderWizardResult();
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
  elements.askButton.disabled = busy || state.assistantBusy;
}

function showPreparationError(error) {
  const active = elements.prepStages.querySelector(".active");
  active?.classList.add("error");
  elements.documentPrep.setAttribute("aria-busy", "false");
  elements.workspace.setAttribute("aria-busy", "false");
  elements.askButton.disabled = state.assistantBusy || !state.catalog.length;
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
  const version = ++state.sqlVersion;
  const sql = await dataStore.call("sql", { plan: state.plan });
  if (version !== state.sqlVersion) return;
  elements.sqlOutput.value = sql;
  state.sqlSource = "wizard";
}

async function runCurrentQuery() {
  elements.runButton.disabled = true;
  try {
    if (state.sqlSource === "wizard") await renderWizardResult();
    else await runEditableQuery();
  } catch (error) {
    renderQueryError(error.message);
  } finally {
    elements.runButton.disabled = false;
  }
}

async function renderWizardResult() {
  const result = await dataStore.call("preview", { plan: state.plan });
  renderTableResult(
    result.columns,
    result.rows.map((row) => result.columns.map((column) => row[column])),
  );
}

async function runEditableQuery() {
  const sql = validateReadQuery(elements.sqlOutput.value);
  setAssistantMessage("Preparing this document for PostgreSQL…");
  await ensurePostgresData();
  const result = await postgres.exec(sql);
  if (result.kind === "error") throw new Error(result.text);
  renderPostgresResult(result);
  setAssistantMessage("The edited query passed PostgreSQL and produced the result below.");
}

async function prepareModel() {
  if (state.modelReady) return { model: "LFM2.5-230M Q4_K_M" };
  if (state.modelLoading) return state.modelLoading;
  elements.modelLoadButton.disabled = true;
  elements.modelStatus.textContent = "Preparing the local model";
  elements.modelProgressCopy.textContent = "Starting the 153 MB download…";
  state.modelLoading = llm.call("load")
    .then((info) => {
      state.modelReady = true;
      return info;
    })
    .catch((error) => {
      elements.modelLoader.classList.add("error");
      elements.modelStatus.textContent = "Model preparation needs another try";
      elements.modelProgressCopy.textContent = error.message;
      elements.modelLoadButton.disabled = false;
      elements.modelLoadButton.textContent = "Try again";
      throw error;
    })
    .finally(() => { state.modelLoading = null; });
  return state.modelLoading;
}

function handleModelEvent(event) {
  if (event.type === "model-progress") {
    const percent = Math.max(0, Math.min(100, event.percent || 0));
    elements.modelLoader.classList.add("loading");
    elements.modelProgressBar.style.width = `${percent}%`;
    elements.modelStatus.textContent = `Downloading the local model · ${percent}%`;
    elements.modelProgressCopy.textContent = event.total
      ? `${formatBytes(event.loaded)} of ${formatBytes(event.total)}`
      : `${formatBytes(event.loaded)} downloaded`;
    return;
  }
  if (event.type !== "model-status") return;
  if (event.status === "ready") {
    state.modelReady = true;
    elements.modelLoader.classList.remove("loading", "error");
    elements.modelLoader.classList.add("ready");
    elements.modelProgressBar.style.width = "100%";
    elements.modelStatus.textContent = "Local model ready";
    elements.modelProgressCopy.textContent = event.backend === "webgpu"
      ? "Ready for local questions with WebGPU acceleration."
      : "Ready for local questions with CPU compatibility.";
    elements.modelLoadButton.textContent = "Model ready";
    elements.modelLoadButton.disabled = true;
  } else if (event.status === "loading") {
    elements.modelLoader.classList.add("loading");
    elements.modelLoader.classList.remove("error");
    elements.modelProgressBar.style.width = "100%";
    elements.modelStatus.textContent = "Starting the local model";
    elements.modelProgressCopy.textContent = "The download is complete. Folio is loading the model into memory.";
  } else if (event.status === "thinking") {
    elements.modelStatus.textContent = "Writing PostgreSQL";
    elements.modelProgressCopy.textContent = "The model is working with this document's schema.";
  }
}

async function checkBrowser() {
  try {
    const result = await capabilities.call("check");
    elements.browserCheck.classList.toggle("ready", result.webgpuReady);
    elements.browserCheck.classList.toggle("fallback", !result.webgpuReady);
    elements.browserCheckTitle.textContent = result.webgpuReady
      ? "WebGPU available"
      : "CPU compatibility ready";
    elements.browserCheckStatus.textContent = result.webgpuReady
      ? `${result.browser} exposes GPU acceleration. Folio will use the CPU runtime.`
      : `${result.browser} can run the local model with the CPU runtime.`;
    elements.browserCheckGuidance.replaceChildren(
      ...result.guidance.map((instruction) => {
        const item = document.createElement("li");
        item.textContent = instruction;
        return item;
      }),
    );
    elements.browserCheck.classList.toggle("needs-guidance", result.guidance.length > 0);
    elements.browserCheckGuidance.hidden = result.guidance.length === 0;
  } catch (error) {
    elements.browserCheck.classList.add("fallback");
    elements.browserCheck.classList.remove("needs-guidance");
    elements.browserCheckTitle.textContent = "CPU compatibility ready";
    elements.browserCheckStatus.textContent = "Folio can start the local model with its CPU runtime.";
    elements.browserCheckGuidance.hidden = true;
  }
}

async function askFolio(event) {
  event.preventDefault();
  const question = elements.askInput.value.trim();
  if (!question) {
    elements.askInput.focus();
    return;
  }

  state.assistantBusy = true;
  elements.askButton.disabled = true;
  resetAssistantStages();
  setAssistantStage("schema");
  setAssistantMessage("Finding the tables and fields that match your question…");

  try {
    const matches = await search.call("search", { query: question });
    const tableNames = matches.slice(0, 10).map((match) => match.id);
    const context = await dataStore.call("assistantContext", { tableNames });
    completeAssistantStage("schema");
    setAssistantStage("plan");
    setAssistantMessage("Planning the report from the inferred schema…");

    const postgresReady = ensurePostgresData().then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    await prepareModel();
    let { proposal } = await llm.call("ask", { question, context });
    proposal = validateProposal(proposal);
    showProposal(proposal);
    completeAssistantStage("plan");
    setAssistantStage("check");
    setAssistantMessage("Checking the query with PostgreSQL…");
    const postgresState = await postgresReady;
    if (postgresState.error) throw postgresState.error;

    let result = await postgres.exec(proposal.sql);
    for (let attempt = 0; result.kind === "error" && attempt < 2; attempt += 1) {
      completeAssistantStage("check");
      setAssistantStage("repair");
      setAssistantMessage(`PostgreSQL returned: ${result.text} Folio is repairing the query…`);
      const repaired = await llm.call("repair", {
        question,
        proposal,
        error: result.error || { message: result.text },
        context,
      });
      proposal = validateProposal(repaired.proposal);
      showProposal(proposal);
      completeAssistantStage("repair");
      setAssistantStage("check");
      result = await postgres.exec(proposal.sql);
    }

    if (result.kind === "error") throw new Error(result.text);
    completeAssistantStage("check");
    completeAssistantStage("repair");
    renderPostgresResult(result);
    showProposalAnswer(proposal);
  } catch (error) {
    markAssistantError();
    setAssistantMessage(`Folio needs another pass at this question. ${error.message}`, true);
  } finally {
    state.assistantBusy = false;
    elements.askButton.disabled = !state.catalog.length;
  }
}

function showProposal(proposal) {
  elements.sqlOutput.value = proposal.sql.trim();
  state.sqlSource = "assistant";
  state.sqlVersion += 1;
}

function showProposalAnswer(proposal) {
  elements.assistantAnswer.replaceChildren();
  const answer = document.createElement("p");
  answer.textContent = proposal.answer;
  elements.assistantAnswer.append(answer);
  if (proposal.assumptions.length) {
    const heading = document.createElement("strong");
    heading.textContent = "How Folio read the question";
    const list = document.createElement("ul");
    for (const assumption of proposal.assumptions) {
      const item = document.createElement("li");
      item.textContent = assumption;
      list.append(item);
    }
    elements.assistantAnswer.append(heading, list);
  }
  elements.assistantAnswer.hidden = false;
}

async function ensurePostgresData() {
  const generation = state.documentGeneration;
  if (state.postgresReadyGeneration === generation) return;
  if (state.postgresLoading) return state.postgresLoading;

  state.postgresLoading = (async () => {
    await postgres.reset();
    assertPostgresResult(await postgres.exec(await dataStore.call("postgresSchema")));
    let offset = 0;
    while (true) {
      if (generation !== state.documentGeneration) {
        throw new Error("A new document is loading. Run this query again when it is ready.");
      }
      const batch = await dataStore.call("postgresBatch", { offset, limit: 10_000 });
      if (batch.sql) assertPostgresResult(await postgres.exec(batch.sql));
      offset = batch.nextOffset;
      const percent = batch.total ? Math.round((offset / batch.total) * 100) : 100;
      setAssistantMessage(`Preparing PostgreSQL · ${percent}%`);
      if (batch.done) break;
    }
    setAssistantMessage("Building PostgreSQL indexes · starting");
    const indexStartedAt = performance.now();
    const indexTimer = window.setInterval(() => {
      const seconds = Math.max(1, Math.round((performance.now() - indexStartedAt) / 1_000));
      setAssistantMessage(`Building PostgreSQL indexes · ${seconds}s`);
    }, 1_000);
    try {
      assertPostgresResult(await postgres.exec(await dataStore.call("postgresIndexes")));
    } finally {
      window.clearInterval(indexTimer);
    }
    state.postgresReadyGeneration = generation;
    setAssistantMessage("PostgreSQL ready · checking the query");
  })();

  try {
    await state.postgresLoading;
  } finally {
    state.postgresLoading = null;
  }
}

function assertPostgresResult(result) {
  if (result.kind === "error") throw new Error(result.text);
  return result;
}

function handlePostgresEvent(event) {
  if (event.type !== "status" || !state.assistantBusy) return;
  if (event.state === "fetching") setAssistantMessage("Starting PostgreSQL in this browser…");
}

function renderPostgresResult(result) {
  if (result.kind === "table") {
    renderTableResult(result.columns, result.rows);
    return;
  }
  elements.rowCount.textContent = "Complete";
  elements.resultWrap.replaceChildren(emptyResult(result.text || "Query complete.", "✓"));
}

function renderTableResult(columns, rows) {
  elements.rowCount.textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  if (!rows.length) {
    elements.resultWrap.replaceChildren(emptyResult(
      "This query returned zero rows. Adjust the query or filter, then run it again.",
      "◇",
    ));
    return;
  }

  const table = document.createElement("table");
  table.className = "result-table";
  const head = table.createTHead().insertRow();
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = friendlyName(column);
    head.append(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const line = body.insertRow();
    for (let index = 0; index < columns.length; index += 1) {
      const cell = line.insertCell();
      cell.textContent = formatValue(row[index]);
      cell.title = cell.textContent;
    }
  }
  elements.resultWrap.replaceChildren(table);
}

function renderQueryError(message) {
  elements.rowCount.textContent = "Query error";
  elements.resultWrap.replaceChildren(emptyResult(message, "!"));
}

function emptyResult(message, symbol) {
  const wrap = document.createElement("div");
  wrap.className = "empty-result";
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = symbol;
  const copy = document.createElement("p");
  copy.textContent = message;
  wrap.append(icon, copy);
  return wrap;
}

function resetAssistantStages() {
  for (const stage of elements.assistantFlow.querySelectorAll("[data-assistant-stage]")) {
    stage.classList.remove("active", "complete", "error");
    stage.removeAttribute("aria-current");
  }
}

function setAssistantStage(name) {
  const stage = elements.assistantFlow.querySelector(`[data-assistant-stage="${name}"]`);
  stage?.classList.add("active");
  stage?.setAttribute("aria-current", "step");
}

function completeAssistantStage(name) {
  const stage = elements.assistantFlow.querySelector(`[data-assistant-stage="${name}"]`);
  stage?.classList.remove("active", "error");
  stage?.classList.add("complete");
  stage?.removeAttribute("aria-current");
}

function markAssistantError() {
  const stage = elements.assistantFlow.querySelector(".active");
  stage?.classList.add("error");
}

function setAssistantMessage(message, error = false) {
  elements.assistantAnswer.replaceChildren();
  const copy = document.createElement("p");
  copy.textContent = message;
  elements.assistantAnswer.append(copy);
  elements.assistantAnswer.classList.toggle("error", error);
  elements.assistantAnswer.hidden = false;
}

function friendlyName(value) {
  return String(value).split("__").at(-1).replaceAll("_", " ");
}

function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}
