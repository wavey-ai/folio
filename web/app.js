import {
  buildExternalModelPrompt,
  validateProposal,
  validateReadQuery,
} from "./assistant-context.js?v=20260918-1";
import { SCHEMA_STARTER_QUERIES } from "./schema-queries.js?v=20260918-1";
import { createCsv, createReportFilename } from "./csv.js?v=20260917-1";
import { PgrustClient } from "./pgrust-client.js?v=20260823-15";
import { RUNTIME_ASSETS } from "./runtime-assets.js?v=20260823-2";
import {
  deleteSavedWork,
  readSavedWork,
  saveSavedWork,
} from "./saved-work.js?v=20260823-1";
import {
  clearWorkspaceDocument,
  readWorkspaceDocument,
  saveWorkspaceDocument,
} from "./workspace-session.js?v=20260917-1";

const WORKSPACE_EDITOR_KEY = "folio-workspace-editor-v1";

const elements = {
  engineState: document.querySelector("#engine-state"),
  fileInput: document.querySelector("#file-input"),
  demoButton: document.querySelector("#demo-button"),
  documentStatus: document.querySelector("#document-status"),
  documentPrep: document.querySelector("#document-prep"),
  documentDropzone: document.querySelector("#document-dropzone"),
  documentService: document.querySelector("#document-service"),
  documentServiceState: document.querySelector("#document-service-state"),
  prepStages: document.querySelector("#prep-stages"),
  activityAnchor: document.querySelector("#activity-anchor"),
  activityCenter: document.querySelector("#activity-center"),
  activityStatus: document.querySelector("#activity-status"),
  activityCurrent: document.querySelector("#activity-current"),
  activityTitle: document.querySelector("#activity-title"),
  activityDetail: document.querySelector("#activity-detail"),
  activityElapsed: document.querySelector("#activity-elapsed"),
  activityMeter: document.querySelector("#activity-meter"),
  activityProgressBar: document.querySelector("#activity-progress-bar"),
  activityToggle: document.querySelector("#activity-toggle"),
  activityCount: document.querySelector("#activity-count"),
  activityLogPanel: document.querySelector("#activity-log-panel"),
  activityLog: document.querySelector("#activity-log"),
  copyActivityLog: document.querySelector("#copy-activity-log"),
  workspace: document.querySelector("#workspace"),
  tableList: document.querySelector("#table-list"),
  tableCount: document.querySelector("#table-count"),
  tableSearch: document.querySelector("#table-search"),
  schemaQueryButtons: [...document.querySelectorAll("[data-schema-query]")],
  tableSelect: document.querySelector("#table-select"),
  operationSelect: document.querySelector("#operation-select"),
  builderTitle: document.querySelector("#builder-title"),
  queryPrompt: document.querySelector("#query-prompt"),
  fieldPicker: document.querySelector("#field-picker"),
  filterBlock: document.querySelector("#filter-block"),
  fieldOptions: document.querySelector("#field-options"),
  filterField: document.querySelector("#filter-field"),
  filterOperator: document.querySelector("#filter-operator"),
  filterValue: document.querySelector("#filter-value"),
  clearFilter: document.querySelector("#clear-filter"),
  runButton: document.querySelector("#run-button"),
  runAgentButton: document.querySelector("#run-agent-button"),
  clearSqlButton: document.querySelector("#clear-sql-button"),
  copyButton: document.querySelector("#copy-button"),
  copyAgentSql: document.querySelector("#copy-agent-sql"),
  sqlOutput: document.querySelector("#sql-output"),
  agentSqlOutput: document.querySelector("#agent-sql-output"),
  sqlPreparationStatus: document.querySelector("#sql-preparation-status"),
  agentSqlStatus: document.querySelector("#agent-sql-status"),
  resultWrap: document.querySelector("#result-wrap"),
  rowCount: document.querySelector("#row-count"),
  downloadCsv: document.querySelector("#download-csv"),
  saveQuery: document.querySelector("#save-query"),
  saveReport: document.querySelector("#save-report"),
  tableTemplate: document.querySelector("#table-template"),
  modelLoader: document.querySelector("#model-loader"),
  modelStatus: document.querySelector("#model-status"),
  modelProgressCopy: document.querySelector("#model-progress-copy"),
  modelProgressBar: document.querySelector("#model-progress-bar"),
  modelLoadButton: document.querySelector("#model-load-button"),
  modelServiceState: document.querySelector("#model-service-state"),
  browserCheck: document.querySelector("#browser-check"),
  browserCheckTitle: document.querySelector("#browser-check-title"),
  browserCheckStatus: document.querySelector("#browser-check-status"),
  browserCheckGuidance: document.querySelector("#browser-check-guidance"),
  runtimeServiceState: document.querySelector("#runtime-service-state"),
  postgresRuntime: document.querySelector("#postgres-runtime"),
  postgresRuntimeStatus: document.querySelector("#postgres-runtime-status"),
  postgresRuntimeState: document.querySelector("#postgres-runtime-state"),
  askForm: document.querySelector("#ask-form"),
  askInput: document.querySelector("#ask-input"),
  chatButton: document.querySelector("#chat-button"),
  askButton: document.querySelector("#ask-button"),
  assistantInlineStatus: document.querySelector("#assistant-inline-status"),
  assistantInlineStatusCopy: document.querySelector("#assistant-inline-status-copy"),
  schemaChat: document.querySelector("#schema-chat"),
  ownModelButton: document.querySelector("#own-model-button"),
  ownModelDialog: document.querySelector("#own-model-dialog"),
  ownModelPrompt: document.querySelector("#own-model-prompt"),
  copyOwnModelPrompt: document.querySelector("#copy-own-model-prompt"),
  closeOwnModel: document.querySelector("#close-own-model"),
  assistantFlow: document.querySelector("#assistant-flow"),
  assistantFeedback: document.querySelector("#assistant-feedback"),
  assistantAnswer: document.querySelector("#assistant-answer"),
  savedWorkButton: document.querySelector("#saved-work-button"),
  savedWorkCount: document.querySelector("#saved-work-count"),
  savedWorkDialog: document.querySelector("#saved-work-dialog"),
  savedWorkTitle: document.querySelector("#saved-work-title"),
  closeSavedWork: document.querySelector("#close-saved-work"),
  savedWorkForm: document.querySelector("#saved-work-form"),
  savedWorkName: document.querySelector("#saved-work-name"),
  confirmSaveWork: document.querySelector("#confirm-save-work"),
  cancelSaveWork: document.querySelector("#cancel-save-work"),
  savedWorkError: document.querySelector("#saved-work-error"),
  savedQueryCount: document.querySelector("#saved-query-count"),
  savedQueryList: document.querySelector("#saved-query-list"),
  savedReportCount: document.querySelector("#saved-report-count"),
  savedReportList: document.querySelector("#saved-report-list"),
};

function WorkerClient(path, onEvent = () => {}) {
  this.path = path;
  this.onEvent = onEvent;
  this.nextId = 0;
  this.pending = new Map();
  this.startWorker();
}

WorkerClient.prototype.startWorker = function startWorker() {
  const worker = new Worker(`${this.path}?v=20260918-1`, { type: "module" });
  this.worker = worker;
  worker.addEventListener("message", ({ data }) => {
    if (data.id === undefined || data.id === null) {
      this.onEvent(data);
      return;
    }
    const request = this.pending.get(data.id);
    if (!request) return;
    this.pending.delete(data.id);
    window.clearTimeout(request.timer);
    if (data.error) {
      const error = new Error(data.error);
      error.output = data.output || "";
      request.reject(error);
    } else request.resolve(data.result);
  });
  const fail = (error) => {
    for (const request of this.pending.values()) {
      window.clearTimeout(request.timer);
      request.reject(error instanceof Error ? error : new Error(error.message || "A document worker stopped."));
    }
    this.pending.clear();
    if (this.worker === worker) this.worker = null;
    worker.terminate();
  };
  worker.addEventListener("error", fail);
  worker.addEventListener("messageerror", fail);
};

WorkerClient.prototype.call = function call(operation, payload = {}, transfer = [], timeoutMs = null) {
  if (!this.worker) this.startWorker();
  const id = ++this.nextId;
  const longOperation = operation === "load" || operation === "ask"
    || operation === "repair" || operation === "chat";
  const requestTimeout = timeoutMs ?? (longOperation ? 1_800_000 : 120_000);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`${operation} took longer than ${formatTimeout(requestTimeout)}.`));
    }, requestTimeout);
    this.pending.set(id, { resolve, reject, timer });
    try {
      this.worker.postMessage({ id, operation, ...payload }, transfer);
    } catch (error) {
      window.clearTimeout(timer);
      this.pending.delete(id);
      reject(error);
    }
  });
};

WorkerClient.prototype.stop = function stop(restart = true) {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  for (const request of this.pending.values()) {
    window.clearTimeout(request.timer);
    request.reject(error);
  }
  this.pending.clear();
  this.worker?.terminate();
  this.worker = null;
  if (restart) this.startWorker();
};

function formatTimeout(milliseconds) {
  if (milliseconds < 60_000) return `${Math.ceil(milliseconds / 1_000)} seconds`;
  const minutes = Math.ceil(milliseconds / 60_000);
  return minutes === 1 ? "one minute" : `${minutes} minutes`;
}

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
  modelInfo: null,
  modelProof: "",
  modelWarmupStartedAt: 0,
  modelWarmupTimer: null,
  assistantBusy: false,
  assistantCancelled: false,
  assistantPhase: "idle",
  assistantMode: "chat",
  queryRecoveryAvailable: false,
  schemaConversation: [],
  activeChatMessage: null,
  activeChatQuestion: "",
  generationCharacters: 0,
  generationAnswerCharacters: 0,
  generationSqlCharacters: 0,
  modelRawResponse: "",
  modelProgressMilestone: -1,
  postgresStatus: "",
  postgresProgressMilestone: -1,
  documentLabel: "document",
  report: null,
  reportDocumentLabel: "",
  reportSql: "",
  reportQuestion: "",
  savedWork: [],
  pendingSavedWork: null,
  deleteSavedWorkId: "",
  deleteSavedWorkTimer: null,
  workspaceEnabled: false,
  activityEvents: [],
  activityStartedAt: 0,
  activityTimer: null,
  activitySignature: "",
  activityKey: "",
  pageHiddenAt: 0,
  sqlSource: "wizard",
  sqlVersion: 0,
  userQueryRunning: false,
  agentQueryRunning: false,
  agentSqlReady: false,
  sqlReplacementPending: false,
  assistantSqlStarted: false,
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
const mapperReady = mapper.call("ready");

const toggleActivityLog = () => {
  const expanded = elements.activityToggle.getAttribute("aria-expanded") === "true";
  elements.activityToggle.setAttribute("aria-expanded", String(!expanded));
  elements.activityLogPanel.hidden = expanded;
  if (!expanded) elements.activityLog.scrollTop = 0;
};

elements.modelLoadButton.addEventListener("click", () => {
  prepareModel().catch(() => {});
});
elements.askForm.addEventListener("submit", chatWithFolio);
elements.askButton.addEventListener("click", askFolio);
elements.ownModelButton.addEventListener("click", prepareOwnModelPrompt);
elements.closeOwnModel.addEventListener("click", () => elements.ownModelDialog.close());
elements.copyOwnModelPrompt.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.ownModelPrompt.value);
  elements.copyOwnModelPrompt.textContent = "Prompt copied";
  window.setTimeout(() => { elements.copyOwnModelPrompt.textContent = "Copy prompt"; }, 1_400);
});
elements.activityToggle.addEventListener("click", toggleActivityLog);
elements.copyActivityLog.addEventListener("click", copyActivityLog);
elements.downloadCsv.addEventListener("click", downloadCsvReport);
elements.saveQuery.addEventListener("click", () => beginSaveWork("query"));
elements.saveReport.addEventListener("click", () => beginSaveWork("report"));
elements.savedWorkButton.addEventListener("click", openSavedWorkDialog);
elements.closeSavedWork.addEventListener("click", () => elements.savedWorkDialog.close());
elements.cancelSaveWork.addEventListener("click", closeSavedWorkForm);
elements.savedWorkForm.addEventListener("submit", commitSavedWork);
elements.savedWorkDialog.addEventListener("close", closeSavedWorkForm);
window.addEventListener("scroll", updateActivityDock, { passive: true });
window.addEventListener("resize", updateActivityDock, { passive: true });
window.addEventListener("pagehide", handlePageHide);
window.addEventListener("pageshow", handlePageShow);
document.addEventListener("visibilitychange", handleVisibilityChange);
for (const eventName of ["dragenter", "dragover"]) {
  elements.documentDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.documentDropzone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.documentDropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.documentDropzone.classList.remove("dragging");
  });
}
elements.documentDropzone.addEventListener("drop", async (event) => {
  const [file] = event.dataTransfer?.files || [];
  if (file) await loadDocumentFile(file);
});
elements.sqlOutput.addEventListener("input", () => {
  state.sqlSource = "edited";
  state.sqlVersion += 1;
  state.sqlReplacementPending = false;
  setSqlStatus("");
  elements.runButton.textContent = "Run my query";
  syncQueryAndReportControls();
  rememberWorkspaceEditor();
});
elements.demoButton.addEventListener("click", loadDiscogsSample);
elements.tableSearch.addEventListener("input", searchTables);
for (const button of elements.schemaQueryButtons) {
  button.addEventListener("click", () => runSchemaStarterQuery(button.dataset.schemaQuery));
}
elements.fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (file) await loadDocumentFile(file);
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
elements.runAgentButton.addEventListener("click", runAgentQuery);
elements.clearSqlButton.addEventListener("click", clearSqlQuery);
elements.copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.sqlOutput.value);
  elements.copyButton.textContent = "Copied";
  window.setTimeout(() => { elements.copyButton.textContent = "Copy"; }, 1400);
});
elements.copyAgentSql.addEventListener("click", async () => {
  await copyText(elements.agentSqlOutput.value);
  elements.copyAgentSql.textContent = "Copied";
  window.setTimeout(() => { elements.copyAgentSql.textContent = "Copy"; }, 1400);
});

async function loadDocumentFile(file) {
  const source = file.name.replace(/\.(json|xml|csv)$/i, "") || "document";
  const extension = file.name.toLowerCase().match(/\.(json|xml|csv)$/)?.[1];
  const format = extension || (file.type.includes("csv") ? "csv" : file.type.includes("xml") ? "xml" : "json");
  setPreparation("read", `Reading ${file.name}…`);
  try {
    const opened = await openDocument(source, await file.arrayBuffer(), format, file.name);
    if (opened) await rememberOpenedDocument({ source, format, label: file.name, blob: file });
  } catch (error) {
    if (error.name !== "AbortError") showPreparationError(error);
  }
}

elements.chatButton.disabled = true;
elements.askButton.disabled = true;
elements.ownModelButton.disabled = true;
refreshSavedWork();
setWorkspaceEnabled(false);
setActivity({
  source: "Folio",
  title: "Starting your local workspace",
  detail: "Checking this browser and preparing the local document tools.",
  progress: null,
  log: true,
});
startPostgresRuntime();
checkBrowser();
await mapperReady;
elements.engineState.classList.add("ready");
elements.engineState.querySelector("strong").textContent = "Ready in this browser";
if (!(await restoreRememberedWorkspace())) {
  setActivity({
    source: "Folio",
    title: "Ready for a document",
    detail: "Drop JSON, XML, or CSV above, or load the demo dataset.",
    status: "ready",
    progress: 0,
  });
}

async function loadDiscogsSample() {
  elements.demoButton.disabled = true;
  elements.demoButton.textContent = "Loading the demo…";
  setPreparation("read", "Reading 30 MB of Discogs releases…");
  try {
    const response = await fetch(RUNTIME_ASSETS.discogsSample);
    if (!response.ok) throw new Error("Folio could not read the Discogs demo.");
    const blob = await response.blob();
    const opened = await openDocument(
      "discogs_releases",
      await blob.arrayBuffer(),
      "xml",
      "Discogs releases",
    );
    if (opened) {
      await rememberOpenedDocument({
        source: "discogs_releases",
        format: "xml",
        label: "Discogs releases",
        blob,
      });
      await runDiscogsDemoReport();
    }
  } catch (error) {
    if (error.name !== "AbortError") showPreparationError(error);
  } finally {
    elements.demoButton.disabled = false;
    elements.demoButton.innerHTML = 'Try on a demo dataset <i aria-hidden="true">→</i>';
  }
}

async function runDiscogsDemoReport() {
  const version = ++state.sqlVersion;
  setSqlStatus("Preparing demo SQL", "preparing");
  const sql = await dataStore.call("sql", { plan: state.plan });
  if (version !== state.sqlVersion) return;
  elements.sqlOutput.value = sql;
  state.sqlSource = "demo";
  elements.builderTitle.textContent = "Electronic artists across releases";
  elements.runButton.textContent = "Run my query";
  setSqlStatus("Running demo SQL", "preparing");
  syncQueryAndReportControls();
  await runCurrentQuery();
}

function startPostgresRuntime() {
  setServiceState(elements.postgresRuntime, elements.postgresRuntimeState, "loading", "Starting");
  elements.postgresRuntimeStatus.textContent = "Starting on page load";
  postgres.boot().then(
    ({ engine }) => {
      elements.postgresRuntimeStatus.textContent = "Ready for a document";
      setServiceState(
        elements.postgresRuntime,
        elements.postgresRuntimeState,
        "ready",
        engine === "wire" ? "Ready" : "Compat",
      );
      appendActivity({
        source: "PostgreSQL",
        title: "PostgreSQL started",
        detail: "The local query engine is ready for a document.",
        status: "ready",
      });
    },
    (error) => {
      elements.postgresRuntimeStatus.textContent = "Will retry with the document";
      setServiceState(elements.postgresRuntime, elements.postgresRuntimeState, "error", "Retry");
      appendActivity({
        source: "PostgreSQL",
        title: "PostgreSQL will retry",
        detail: error.message,
        status: "error",
        details: { message: error.message },
      });
    },
  );
}

async function openDocument(source, buffer, format, label) {
  await mapperReady;
  const generation = ++state.documentGeneration;
  mapper.stop();
  dataStore.stop();
  search.stop();
  state.documentLabel = label || source || "document";
  state.postgresReadyGeneration = 0;
  state.postgresLoading = null;
  state.postgresStatus = "";
  state.postgresProgressMilestone = -1;
  clearReport();
  clearAgentSql();
  elements.postgresRuntimeStatus.textContent = postgres.engine
    ? "Runtime ready · loading tables next"
    : "Starting with this document";
  setServiceState(
    elements.postgresRuntime,
    elements.postgresRuntimeState,
    postgres.engine ? "ready" : "loading",
    postgres.engine ? "Ready" : "Starting",
  );
  setPreparation("map", "Mapping the document structure…");
  const mapped = await mapper.call("map", { source, format, buffer }, [buffer]);
  if (generation !== state.documentGeneration) return false;
  setPreparation("catalog", "Building queryable tables…");
  const result = await dataStore.call("load", { buffer: mapped, label }, [mapped]);
  if (generation !== state.documentGeneration) return false;
  mapper.stop();
  state.catalog = result.catalog;
  state.leafCount = result.leafCount;
  state.visibleTables = state.catalog;
  resetSchemaConversation(label, result);
  const discogsTable = state.catalog.find(
    (table) => table.name === "discogs_releases__release",
  );
  const table = discogsTable || state.catalog[0];
  state.plan.table = table?.name || "";
  state.plan.fields = table?.fields.map((field) => field.name) || [];
  state.plan.operation = configureDemoReport(Boolean(discogsTable));
  state.plan.filter = { field: "", operator: "equals", value: "" };
  if (discogsTable && !elements.askInput.value.trim()) {
    elements.askInput.value = "Which artists have the most Electronic releases? Show each artist's release count, track count, distinct label count, label names, and styles. Include artists with at least three releases and sort by release count, then track count.";
  }
  state.sqlSource = "wizard";
  elements.tableSearch.value = "";
  setPreparation("index", "Indexing elements and fields…");
  const [, postgresState] = await Promise.all([
    search.call("load", { catalog: state.catalog }),
    ensurePostgresData().then(
      () => ({ error: null }),
      (error) => ({ error }),
    ),
  ]);
  if (generation !== state.documentGeneration) return false;
  renderSchema();
  renderPlanner();
  await renderWizardResult(false);
  setPreparation(
    "ready",
    `${label} has ${state.catalog.length} tables and ${result.valueCount} values.`,
  );
  if (postgresState.error) {
    appendActivity({
      source: "PostgreSQL",
      title: "The document is ready; PostgreSQL can retry",
      detail: postgresState.error.message,
      status: "error",
      details: { message: postgresState.error.message },
    });
  }
  rememberWorkspaceEditor();
  return true;
}

function configureDemoReport(available) {
  elements.operationSelect.querySelector('[value="discogs-artist-overview"]')?.remove();
  if (!available) return "rows";
  elements.operationSelect.add(new Option(
    "Electronic artists · recursive report",
    "discogs-artist-overview",
  ));
  return "discogs-artist-overview";
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
  elements.chatButton.disabled = busy || state.assistantBusy;
  elements.askButton.disabled = busy || state.assistantBusy;
  elements.ownModelButton.disabled = busy;
  setWorkspaceEnabled(!busy && Boolean(state.catalog.length));
  setServiceState(
    elements.documentService,
    elements.documentServiceState,
    busy ? "loading" : "ready",
  );

  const activity = {
    read: {
      title: "Reading the document",
      detail: "Loading its bytes on this device.",
      progress: 8,
    },
    map: {
      title: "Mapping the structure",
      detail: "Discovering paths and parent-child relationships.",
      progress: 34,
    },
    catalog: {
      title: "Building queryable tables",
      detail: "Inferring records, fields, and data types.",
      progress: 62,
    },
    index: {
      title: "Indexing elements and fields",
      detail: "Preparing instant structure search for this document.",
      progress: 86,
    },
    ready: {
      title: "Document ready",
      detail: message,
      progress: 100,
    },
  }[stage];
  if (activity) {
    setActivity({
      source: "Document",
      ...activity,
      status: busy ? "working" : "ready",
      details: { stage, document: state.documentLabel },
    });
  }
}

function showPreparationError(error) {
  const active = elements.prepStages.querySelector(".active");
  active?.classList.add("error");
  elements.documentPrep.setAttribute("aria-busy", "false");
  elements.workspace.setAttribute("aria-busy", "false");
  elements.chatButton.disabled = state.assistantBusy || !state.catalog.length;
  elements.askButton.disabled = state.assistantBusy || !state.catalog.length;
  elements.ownModelButton.disabled = !state.catalog.length;
  elements.documentStatus.textContent = `Review this document's format. ${error.message}`;
  setServiceState(elements.documentService, elements.documentServiceState, "error");
  setActivity({
    source: "Document",
    title: "Document needs attention",
    detail: `Review its format. ${error.message}`,
    status: "error",
    details: { message: error.message },
  });
}

function setWorkspaceEnabled(enabled) {
  state.workspaceEnabled = enabled;
  for (const control of [
    elements.tableSearch,
    elements.tableSelect,
    elements.operationSelect,
    elements.filterField,
    elements.filterOperator,
    elements.filterValue,
    elements.clearFilter,
  ]) {
    control.disabled = !enabled;
  }
  syncQueryAndReportControls();
}

function syncQueryAndReportControls() {
  const hasSql = Boolean(elements.sqlOutput.value.trim());
  const hasAgentSql = Boolean(elements.agentSqlOutput.value.trim());
  elements.sqlOutput.disabled = false;
  elements.runButton.disabled = state.userQueryRunning || !state.workspaceEnabled || !hasSql;
  elements.clearSqlButton.disabled = !hasSql;
  elements.copyButton.disabled = !hasSql;
  elements.saveQuery.disabled = !hasSql;
  elements.runAgentButton.disabled = state.agentQueryRunning
    || !state.workspaceEnabled
    || !state.agentSqlReady
    || !hasAgentSql;
  elements.copyAgentSql.disabled = !hasAgentSql;
  for (const button of elements.schemaQueryButtons) {
    button.disabled = !state.workspaceEnabled || state.userQueryRunning;
  }
  elements.saveReport.disabled = !state.report;
  elements.downloadCsv.disabled = !state.report?.columns?.length;
}

async function runSchemaStarterQuery(key) {
  const sql = SCHEMA_STARTER_QUERIES[key];
  if (!sql || !state.workspaceEnabled || state.userQueryRunning) return;
  state.sqlVersion += 1;
  state.sqlSource = "schema";
  state.sqlReplacementPending = false;
  elements.sqlOutput.value = sql;
  elements.sqlOutput.readOnly = false;
  elements.queryPrompt.hidden = true;
  elements.builderTitle.textContent = "Exploring the universal schema";
  setSqlStatus("Starter query ready", "ready");
  syncQueryAndReportControls();
  rememberWorkspaceEditor();
  if (window.matchMedia("(max-width: 900px)").matches) {
    elements.sqlOutput.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  await runCurrentQuery();
}

function clearSqlQuery({ announce = true } = {}) {
  state.sqlVersion += 1;
  state.sqlSource = "edited";
  state.sqlReplacementPending = false;
  state.assistantSqlStarted = false;
  elements.sqlOutput.value = "";
  elements.sqlOutput.readOnly = false;
  elements.sqlOutput.removeAttribute("aria-busy");
  elements.sqlOutput.placeholder = state.workspaceEnabled
    ? "Write PostgreSQL here or use the report builder."
    : "Open a document to build PostgreSQL";
  elements.queryPrompt.hidden = true;
  elements.runButton.textContent = "Run my query";
  elements.builderTitle.textContent = state.workspaceEnabled
    ? "Build or write a query"
    : "Open a document to start";
  setSqlStatus("");
  clearReport();
  elements.rowCount.textContent = "0 rows";
  elements.resultWrap.replaceChildren(emptyResult(
    state.workspaceEnabled
      ? "Write a query or use the builder to create one."
      : "Open a document to start building a report.",
    "↳",
  ));
  syncQueryAndReportControls();
  rememberWorkspaceEditor();
  if (state.workspaceEnabled) elements.sqlOutput.focus();
  if (announce) {
    appendActivity({
      source: "Report",
      title: "Query cleared",
      detail: "The document remains ready for your next query.",
      status: "ready",
    });
  }
}

function clearAgentSql() {
  elements.agentSqlOutput.value = "";
  elements.agentSqlOutput.removeAttribute("aria-busy");
  state.agentSqlReady = false;
  state.assistantSqlStarted = false;
  state.generationSqlCharacters = 0;
  setAgentSqlStatus("");
  syncQueryAndReportControls();
}

function writeAgentSqlDraft(sql, { ready = false } = {}) {
  const draft = String(sql || "").trim();
  if (!draft) return false;
  elements.agentSqlOutput.value = draft;
  elements.agentSqlOutput.scrollTop = elements.agentSqlOutput.scrollHeight;
  state.sqlReplacementPending = false;
  state.assistantSqlStarted = true;
  state.agentSqlReady = ready;
  state.generationSqlCharacters = Math.max(state.generationSqlCharacters, draft.length);
  if (ready) {
    elements.agentSqlOutput.removeAttribute("aria-busy");
    setAgentSqlStatus("Ready to run", "ready");
  } else {
    elements.agentSqlOutput.setAttribute("aria-busy", "true");
    setAgentSqlStatus(`Writing · ${draft.length.toLocaleString()} characters`, "preparing");
  }
  syncQueryAndReportControls();
  if (ready) rememberWorkspaceEditor();
  return true;
}

function isRunnableSql(sql) {
  try {
    validateReadQuery(sql);
    return true;
  } catch {
    return false;
  }
}

function setSqlStatus(message, status = "preparing") {
  setQueryStatus(elements.sqlPreparationStatus, message, status);
}

function setAgentSqlStatus(message, status = "preparing") {
  setQueryStatus(elements.agentSqlStatus, message, status);
}

function setQueryStatus(element, message, status) {
  const copy = element.querySelector("span");
  copy.textContent = message;
  element.dataset.state = status;
  element.hidden = !message;
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function rememberWorkspaceEditor() {
  if (!state.workspaceEnabled) return;
  try {
    browserSessionStorage()?.setItem(WORKSPACE_EDITOR_KEY, JSON.stringify({
      documentLabel: state.documentLabel,
      sql: elements.sqlOutput.value,
      agentSql: elements.agentSqlOutput.value,
      question: elements.queryPrompt.hidden ? "" : elements.queryPrompt.textContent,
      ask: elements.askInput.value,
      title: elements.builderTitle.textContent,
      savedAt: new Date().toISOString(),
    }));
  } catch {
    // The open workspace remains available when session storage is full.
  }
}

function readWorkspaceEditor() {
  try {
    const value = browserSessionStorage()?.getItem(WORKSPACE_EDITOR_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function rememberOpenedDocument(document) {
  try {
    await saveWorkspaceDocument(document);
    rememberWorkspaceEditor();
  } catch (error) {
    appendActivity({
      source: "Workspace",
      title: "This document is ready in the current tab",
      detail: "Use Save query or Save report to keep the analysis for later.",
      status: "info",
      details: { message: error.message },
    });
  }
}

async function restoreRememberedWorkspace({ resumed = false } = {}) {
  const editor = readWorkspaceEditor();
  let remembered;
  try {
    remembered = await readWorkspaceDocument();
  } catch (error) {
    appendActivity({
      source: "Workspace",
      title: "Ready for a document",
      detail: "Open JSON, XML, or CSV to start a new workspace.",
      status: "info",
      details: { message: error.message },
    });
    return false;
  }
  if (!remembered) return false;

  setPreparation("read", `Restoring ${remembered.label}…`);
  try {
    const opened = await openDocument(
      remembered.source,
      await remembered.blob.arrayBuffer(),
      remembered.format,
      remembered.label,
    );
    if (!opened) return false;
    if (editor?.documentLabel === remembered.label) {
      await restoreWorkspaceEditor(editor);
    }
    setActivity({
      source: "Workspace",
      title: resumed ? "Workspace restored" : "Previous workspace restored",
      detail: `${remembered.label} and its query are ready.`,
      status: "ready",
      progress: 100,
    });
    return true;
  } catch (error) {
    await clearWorkspaceDocument().catch(() => {});
    appendActivity({
      source: "Workspace",
      title: "Ready for a document",
      detail: "Open JSON, XML, or CSV to start a new workspace.",
      status: "error",
      details: { message: error.message },
    });
    return false;
  }
}

async function restoreWorkspaceEditor(editor) {
  elements.sqlOutput.value = typeof editor.sql === "string" ? editor.sql : "";
  elements.agentSqlOutput.value = typeof editor.agentSql === "string" ? editor.agentSql : "";
  state.agentSqlReady = isRunnableSql(elements.agentSqlOutput.value);
  elements.askInput.value = typeof editor.ask === "string" ? editor.ask : elements.askInput.value;
  elements.queryPrompt.textContent = typeof editor.question === "string" ? editor.question : "";
  elements.queryPrompt.hidden = !elements.queryPrompt.textContent;
  elements.builderTitle.textContent = editor.title || "Build or write a query";
  state.sqlSource = "restored";
  state.sqlVersion += 1;
  setSqlStatus(elements.sqlOutput.value.trim() ? "SQL restored" : "");
  setAgentSqlStatus(
    state.agentSqlReady
      ? "Folio SQL restored"
      : elements.agentSqlOutput.value.trim()
        ? "Review restored Folio SQL"
        : "",
    state.agentSqlReady ? "ready" : "error",
  );
  syncQueryAndReportControls();
  if (elements.sqlOutput.value.trim()) await runCurrentQuery();
  else clearSqlQuery({ announce: false });
}

function handlePageHide() {
  state.pageHiddenAt = Date.now();
  rememberWorkspaceEditor();
  if (!state.assistantBusy && !state.modelLoading) return;
  state.assistantCancelled = state.assistantBusy;
  llm.stop(false);
  state.modelReady = false;
  state.modelLoading = null;
  state.modelInfo = null;
  stopModelWarmup();
}

function handlePageShow(event) {
  updateActivityDock();
  if (event.persisted) resumePreservedWorkspace();
}

function handleVisibilityChange() {
  if (document.visibilityState === "hidden") {
    state.pageHiddenAt = Date.now();
    rememberWorkspaceEditor();
    return;
  }
  if (state.pageHiddenAt) resumePreservedWorkspace();
}

function resumePreservedWorkspace() {
  state.pageHiddenAt = 0;
  updateActivityDock();
  syncQueryAndReportControls();
  if (!state.workspaceEnabled) return;
  setActivity({
    source: "Workspace",
    title: "Workspace resumed",
    detail: "Your document and query are ready where you left them.",
    status: "ready",
    progress: 100,
  });
}

function refreshSavedWork() {
  state.savedWork = readSavedWork(browserStorage());
  renderSavedWorkLibrary();
}

function openSavedWorkDialog() {
  refreshSavedWork();
  if (!elements.savedWorkDialog.open) elements.savedWorkDialog.showModal();
}

function beginSaveWork(kind) {
  const question = kind === "report"
    ? state.reportQuestion || currentReportQuestion()
    : currentReportQuestion();
  const documentLabel = kind === "report"
    ? state.reportDocumentLabel || state.documentLabel
    : state.documentLabel;
  state.pendingSavedWork = {
    kind,
    title: defaultSavedWorkTitle(kind, question, documentLabel),
    documentLabel,
    question,
    sql: kind === "report" ? state.reportSql || elements.sqlOutput.value : elements.sqlOutput.value,
    report: kind === "report" ? state.report : null,
  };
  showSavedWorkForm(kind === "report" ? "Save report" : "Save query", "Save");
}

function beginRenameSavedWork(item) {
  state.pendingSavedWork = { ...item };
  showSavedWorkForm("Rename saved work", "Rename");
}

function showSavedWorkForm(title, action) {
  refreshSavedWork();
  elements.savedWorkTitle.textContent = title;
  elements.confirmSaveWork.textContent = action;
  elements.savedWorkName.value = state.pendingSavedWork?.title || "";
  elements.savedWorkError.hidden = true;
  elements.savedWorkError.textContent = "";
  elements.savedWorkForm.hidden = false;
  if (!elements.savedWorkDialog.open) elements.savedWorkDialog.showModal();
  window.requestAnimationFrame(() => {
    elements.savedWorkName.focus();
    elements.savedWorkName.select();
  });
}

function closeSavedWorkForm() {
  state.pendingSavedWork = null;
  elements.savedWorkTitle.textContent = "Saved work";
  elements.confirmSaveWork.textContent = "Save";
  elements.savedWorkName.value = "";
  elements.savedWorkForm.hidden = true;
  elements.savedWorkError.hidden = true;
  elements.savedWorkError.textContent = "";
  resetDeleteSavedWorkConfirmation(false);
}

function commitSavedWork(event) {
  event.preventDefault();
  if (!state.pendingSavedWork) return;
  try {
    const result = saveSavedWork(browserStorage(), {
      ...state.pendingSavedWork,
      title: elements.savedWorkName.value,
    });
    const savedItem = result.item;
    state.savedWork = result.items;
    closeSavedWorkForm();
    renderSavedWorkLibrary();
    appendActivity({
      source: "Saved work",
      title: savedItem.kind === "report" ? "Report saved" : "Query saved",
      detail: `${savedItem.title} is ready in Saved work.`,
      status: "ready",
    });
  } catch (error) {
    showSavedWorkError(error.message);
  }
}

function showSavedWorkError(message) {
  elements.savedWorkError.textContent = message;
  elements.savedWorkError.hidden = false;
}

function renderSavedWorkLibrary() {
  const queries = state.savedWork.filter((item) => item.kind === "query");
  const reports = state.savedWork.filter((item) => item.kind === "report");
  elements.savedWorkCount.textContent = String(state.savedWork.length);
  elements.savedQueryCount.textContent = String(queries.length);
  elements.savedReportCount.textContent = String(reports.length);
  renderSavedWorkList(elements.savedQueryList, queries, "Save a query to keep it here.");
  renderSavedWorkList(elements.savedReportList, reports, "Save a report to keep its current results here.");
}

function renderSavedWorkList(container, items, emptyCopy) {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "saved-work-empty";
    empty.textContent = emptyCopy;
    container.append(empty);
    return;
  }
  for (const item of items) container.append(savedWorkItem(item));
}

function savedWorkItem(item) {
  const article = document.createElement("article");
  article.className = "saved-work-item";
  article.dataset.savedWorkId = item.id;

  const copy = document.createElement("div");
  copy.className = "saved-work-item-copy";
  const title = document.createElement("strong");
  title.textContent = item.title;
  title.title = item.title;
  const metadata = document.createElement("small");
  const rowCopy = item.kind === "report"
    ? `${item.report.rows.length} ${item.report.rows.length === 1 ? "row" : "rows"} · `
    : "";
  metadata.textContent = `${rowCopy}${item.documentLabel} · Updated ${formatSavedWorkDate(item.updatedAt)}`;
  copy.append(title, metadata);

  const actions = document.createElement("div");
  actions.className = "saved-work-item-actions";
  actions.append(savedWorkAction(
    item.kind === "report" ? "Open report" : "Open query",
    "primary-button",
    () => openSavedWork(item),
  ));
  if (item.kind === "report") {
    actions.append(savedWorkAction("Download CSV", "secondary-button", () => {
      downloadReportCsv(item.report, item.documentLabel);
      appendActivity({
        source: "Saved work",
        title: "CSV downloaded",
        detail: `${item.title} was downloaded with ${item.report.rows.length} ${item.report.rows.length === 1 ? "row" : "rows"}.`,
        status: "ready",
      });
    }));
  }
  actions.append(savedWorkAction("Rename", "secondary-button", () => beginRenameSavedWork(item)));
  const deleteButton = savedWorkAction(
    state.deleteSavedWorkId === item.id ? "Delete?" : "Delete",
    `secondary-button saved-work-delete${state.deleteSavedWorkId === item.id ? " confirming" : ""}`,
    () => confirmDeleteSavedWork(item),
  );
  deleteButton.setAttribute(
    "aria-label",
    state.deleteSavedWorkId === item.id ? `Confirm delete ${item.title}` : `Delete ${item.title}`,
  );
  actions.append(deleteButton);
  article.append(copy, actions);
  return article;
}

function savedWorkAction(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function openSavedWork(item) {
  elements.sqlOutput.value = item.sql;
  elements.sqlOutput.readOnly = false;
  elements.sqlOutput.removeAttribute("aria-busy");
  elements.sqlOutput.placeholder = "";
  elements.builderTitle.textContent = item.title;
  elements.queryPrompt.textContent = item.question;
  elements.queryPrompt.hidden = !item.question;
  elements.askInput.value = item.question;
  elements.runButton.textContent = "Run my query";
  state.sqlSource = "saved";
  state.sqlVersion += 1;

  if (item.kind === "report") {
    renderTableResult(item.report.columns, item.report.rows, {
      announce: false,
      documentLabel: item.documentLabel,
    });
  } else {
    clearReport();
    elements.rowCount.textContent = "Saved query";
    elements.resultWrap.replaceChildren(emptyResult(
      state.workspaceEnabled
        ? "Run this saved query with the open document."
        : `Open ${item.documentLabel}, then run this saved query.`,
      "↳",
    ));
  }

  syncQueryAndReportControls();
  elements.savedWorkDialog.close();
  elements.sqlOutput.scrollIntoView({ block: "center" });
  appendActivity({
    source: "Saved work",
    title: item.kind === "report" ? "Saved report opened" : "Saved query opened",
    detail: item.kind === "report"
      ? `${item.title} is ready to view or download.`
      : `${item.title} is ready to edit${state.workspaceEnabled ? " or run" : ""}.`,
    status: "ready",
  });
}

function confirmDeleteSavedWork(item) {
  if (state.deleteSavedWorkId !== item.id) {
    resetDeleteSavedWorkConfirmation(false);
    state.deleteSavedWorkId = item.id;
    state.deleteSavedWorkTimer = window.setTimeout(() => {
      state.deleteSavedWorkId = "";
      state.deleteSavedWorkTimer = null;
      renderSavedWorkLibrary();
    }, 5_000);
    renderSavedWorkLibrary();
    return;
  }

  try {
    state.savedWork = deleteSavedWork(browserStorage(), item.id);
    resetDeleteSavedWorkConfirmation(false);
    renderSavedWorkLibrary();
    appendActivity({
      source: "Saved work",
      title: item.kind === "report" ? "Saved report deleted" : "Saved query deleted",
      detail: `${item.title} was removed from Saved work.`,
      status: "ready",
    });
  } catch (error) {
    showSavedWorkError(error.message);
  }
}

function resetDeleteSavedWorkConfirmation(render = true) {
  if (state.deleteSavedWorkTimer) window.clearTimeout(state.deleteSavedWorkTimer);
  state.deleteSavedWorkTimer = null;
  state.deleteSavedWorkId = "";
  if (render) renderSavedWorkLibrary();
}

function currentReportQuestion() {
  if (!elements.queryPrompt.hidden && elements.queryPrompt.textContent.trim()) {
    return elements.queryPrompt.textContent.trim();
  }
  return elements.askInput.value.trim();
}

function defaultSavedWorkTitle(kind, question, documentLabel) {
  if (question) return question.replace(/\s+/g, " ").slice(0, 80);
  const source = String(documentLabel || "Document").replace(/\.(json|xml|csv)$/i, "");
  return `${source} ${kind}`.slice(0, 80);
}

function formatSavedWorkDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
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
  if (state.plan.operation === "discogs-artist-overview") state.plan.operation = "rows";
  state.plan.fields = table.fields.map((field) => field.name);
  state.plan.filter = { field: "", operator: "equals", value: "" };
  elements.filterValue.value = "";
  renderSchema();
  renderPlanner();
}

function renderPlanner() {
  const table = state.catalog.find((item) => item.name === state.plan.table);
  const relationshipReport = state.plan.operation === "discogs-artist-overview";
  const treeReport = state.plan.operation === "tree";
  elements.operationSelect.value = state.plan.operation;
  elements.queryPrompt.hidden = !relationshipReport && !treeReport;
  elements.queryPrompt.textContent = relationshipReport
    ? "WITH RECURSIVE follows each release’s nested records to compare Electronic artists, tracks, labels, and styles."
    : treeReport ? "WITH RECURSIVE follows parent_id from each root through every level of the document tree." : "";
  elements.fieldPicker.hidden = relationshipReport || treeReport;
  elements.filterBlock.hidden = relationshipReport || treeReport;
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
    pill.title = field.name;
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
  if (state.assistantBusy) return;
  const version = ++state.sqlVersion;
  setSqlStatus("Preparing SQL", "preparing");
  const sql = await dataStore.call("sql", { plan: state.plan });
  if (version !== state.sqlVersion) return;
  elements.sqlOutput.value = sql;
  state.sqlSource = "wizard";
  elements.builderTitle.textContent = "Ask this document";
  elements.runButton.textContent = "Run my query";
  setSqlStatus("SQL ready", "ready");
  syncQueryAndReportControls();
}

async function runCurrentQuery() {
  if (state.userQueryRunning) return;
  state.userQueryRunning = true;
  elements.runButton.textContent = "Running…";
  syncQueryAndReportControls();
  clearReport();
  setActivity({
    source: "Report",
    title: state.sqlSource === "wizard" ? "Building your preview" : "Running your PostgreSQL",
    detail: state.sqlSource === "wizard"
      ? "Reading the selected fields from the local document store."
      : "Preparing the local database and checking your query.",
    progress: null,
  });
  try {
    if (state.sqlSource === "wizard") await renderWizardResult(true);
    else await runEditableQuery();
  } catch (error) {
    setSqlStatus("SQL needs attention", "error");
    renderQueryError(error.message);
  } finally {
    state.userQueryRunning = false;
    elements.runButton.innerHTML = 'Run my query <i aria-hidden="true">→</i>';
    syncQueryAndReportControls();
  }
}

async function runAgentQuery() {
  if (state.agentQueryRunning || !state.agentSqlReady) return;
  state.agentQueryRunning = true;
  elements.runAgentButton.textContent = "Running…";
  syncQueryAndReportControls();
  clearReport();
  setAgentSqlStatus("Running with PostgreSQL", "preparing");
  setActivity({
    source: "PostgreSQL",
    title: "Running Folio’s query",
    detail: "PostgreSQL is reading the inferred records and relationships.",
    progress: null,
  });
  try {
    await runPostgresQuery(elements.agentSqlOutput.value, {
      question: state.activeChatQuestion || elements.askInput.value.trim(),
    });
    setAgentSqlStatus("Ready to run", "ready");
  } catch (error) {
    setAgentSqlStatus("Review this SQL", "error");
    renderQueryError(error.message);
  } finally {
    state.agentQueryRunning = false;
    elements.runAgentButton.innerHTML = 'Run Folio query <i aria-hidden="true">→</i>';
    syncQueryAndReportControls();
  }
}

async function renderWizardResult(announce = true) {
  const result = await dataStore.call("preview", { plan: state.plan });
  state.reportSql = elements.sqlOutput.value;
  state.reportQuestion = currentReportQuestion();
  renderTableResult(
    result.columns,
    result.rows.map((row) => result.columns.map((column) => row[column])),
    { announce },
  );
}

async function runEditableQuery() {
  await runPostgresQuery(elements.sqlOutput.value, {
    question: currentReportQuestion(),
    status: "user",
  });
}

async function runPostgresQuery(query, { question = "", status = "agent" } = {}) {
  const sql = validateReadQuery(query);
  setAssistantMessage("Preparing this document for PostgreSQL…");
  setActivity({
    source: "PostgreSQL",
    title: "Preparing your query",
    detail: "Loading this document into the local PostgreSQL runtime.",
    progress: null,
  });
  await ensurePostgresData();
  setActivity({
    source: "PostgreSQL",
    title: "Running your query",
    detail: "PostgreSQL is reading the inferred tables and relationships.",
    progress: null,
  });
  const result = await postgres.exec(sql);
  if (result.kind === "error") throw new Error(result.text);
  state.reportSql = sql;
  state.reportQuestion = question;
  renderPostgresResult(result);
  if (status === "user") setSqlStatus("SQL ready", "ready");
  setAssistantMessage("The edited query passed PostgreSQL and produced the result below.");
}

async function prepareModel() {
  if (state.modelReady) return state.modelInfo || { model: "Qwen3.5-0.8B Q4_K_M" };
  if (state.modelLoading) return state.modelLoading;
  elements.modelLoadButton.disabled = true;
  elements.modelLoadButton.textContent = "Starting";
  elements.modelStatus.textContent = "Preparing the local model";
  elements.modelProgressCopy.textContent = "Starting the 533 MB download…";
  state.modelProgressMilestone = -1;
  setServiceState(elements.modelLoader, elements.modelServiceState, "loading", "Starting");
  setActivity({
    source: "Assistant",
    title: "Starting the local assistant",
    detail: "Preparing Qwen3.5 on this device. The model stays in your browser cache.",
    progress: 0,
  });
  state.modelLoading = llm.call("load")
    .then((info) => {
      state.modelReady = true;
      state.modelInfo = info;
      return info;
    })
    .catch((error) => {
      stopModelWarmup();
      if (state.assistantCancelled || error.name === "AbortError") {
        setServiceState(elements.modelLoader, elements.modelServiceState, "idle", "Cached");
        elements.modelStatus.textContent = "Local assistant paused";
        elements.modelProgressCopy.textContent = "The model stays cached and will restart with your next question.";
        elements.modelLoadButton.disabled = false;
        elements.modelLoadButton.textContent = "Restart";
        throw error;
      }
      setServiceState(elements.modelLoader, elements.modelServiceState, "error");
      elements.modelStatus.textContent = "Model preparation needs another try";
      elements.modelProgressCopy.textContent = error.message;
      elements.modelLoadButton.disabled = false;
      elements.modelLoadButton.textContent = "Try again";
      setActivity({
        source: "Assistant",
        title: "Local model needs attention",
        detail: error.message,
        status: "error",
        details: { message: error.message, output: error.output || "" },
      });
      throw error;
    })
    .finally(() => { state.modelLoading = null; });
  return state.modelLoading;
}

function handleModelEvent(event) {
  if (event.type === "model-event") {
    logModelEvent(event.level, event.event, event.details, event.at);
    handleReadableModelEvent(event);
    return;
  }
  if (event.type === "model-log") {
    logModelEvent(event.level, "llama.cpp", { message: event.message }, event.at);
    if ((event.level === "error" || event.level === "warn")
      && /abort|failed|error|webgpu|memory|unreachable/i.test(event.message)) {
      appendActivity({
        source: "Runtime",
        title: event.level === "error" ? "Runtime error" : "Runtime note",
        detail: event.message.slice(0, 260),
        status: event.level === "error" ? "error" : "info",
        details: { message: event.message },
        at: event.at,
      });
    }
    return;
  }
  if (event.type === "model-warmup") {
    startModelWarmup(event.elapsedMs);
    return;
  }
  if (event.type === "model-runtime") {
    const seconds = Math.max(1, Math.round((event.elapsedMs || 0) / 1_000));
    const phase = event.phase || "Starting the inference runtime";
    const gpu = event.backend === "webgpu";
    setAssistantInlineStatus(`${phase} · ${formatDuration(seconds)}`);
    setServiceState(elements.modelLoader, elements.modelServiceState, "loading", gpu ? "Starting GPU" : "Starting CPU");
    elements.modelStatus.textContent = `${phase} · ${seconds}s`;
    elements.modelProgressCopy.textContent = gpu
      ? "The model download is complete. This browser is preparing WebGPU inference."
      : "The model download is complete. This browser is preparing CPU inference.";
    setActivity({
      source: "Runtime",
      title: phase,
      detail: `${formatDuration(seconds)} elapsed · ${gpu ? "WebGPU" : "CPU"} startup is active.`,
      progress: null,
      log: false,
      key: "assistant:runtime",
    });
    return;
  }
  if (event.type === "model-chat") {
    state.generationCharacters = Math.max(state.generationCharacters, event.characters || 0);
    if (event.text) {
      state.generationAnswerCharacters = Math.max(
        state.generationAnswerCharacters,
        event.text.length,
      );
    }
    if (event.sql) writeAgentSqlDraft(event.sql);
    const seconds = Math.max(1, Math.round(event.elapsedMs / 1_000));
    const answerWriting = state.generationAnswerCharacters > 0;
    const sqlWriting = state.generationSqlCharacters > 0;
    const visibleCharacters = state.generationAnswerCharacters + state.generationSqlCharacters;
    const writing = visibleCharacters > 0;
    const writingLabel = answerWriting && sqlWriting
      ? "Writing the answer and PostgreSQL"
      : sqlWriting
        ? "Writing PostgreSQL"
        : "Writing the answer";
    setAssistantInlineStatus(writing
      ? `${writingLabel} · ${formatDuration(seconds)} · ${visibleCharacters.toLocaleString()} visible characters`
      : `${formatDuration(seconds)} elapsed · preparing visible output`);
    elements.modelStatus.textContent = writing
      ? `${writingLabel} · ${seconds}s`
      : `Reading the schema · ${seconds}s`;
    elements.modelProgressCopy.textContent = writing
      ? `${visibleCharacters.toLocaleString()} characters are visible in the answer and Folio SQL panels.`
      : "The model is finding the relevant records and relationships.";
    setServiceState(elements.modelLoader, elements.modelServiceState, "loading", "Answering");
    if (state.assistantPhase === "chat") {
      if (event.text) updateChatMessage(state.activeChatMessage, event.text);
      else if (event.sql) {
        updateChatMessage(
          state.activeChatMessage,
          "Writing the report query in Folio’s PostgreSQL panel…",
        );
      }
      else if (!writing) {
        updateChatMessage(
          state.activeChatMessage,
          `Reading the relevant schema · ${seconds}s`,
        );
      }
      setActivity({
        source: "Assistant",
        title: writing ? writingLabel : "Reading the relevant schema",
        detail: writing
          ? `${visibleCharacters.toLocaleString()} visible characters · ${formatDuration(seconds)} elapsed.`
          : `${formatDuration(seconds)} elapsed · preparing visible output.`,
        progress: null,
        log: false,
        key: "assistant:chat",
      });
    }
    return;
  }
  if (event.type === "model-generation") {
    if (event.raw) state.modelRawResponse = event.raw;
    state.generationCharacters = Math.max(state.generationCharacters, event.characters || 0);
    const seconds = Math.max(1, Math.round(event.elapsedMs / 1_000));
    const writing = state.generationCharacters > 0;
    const waiting = !writing && seconds >= 45;
    setAssistantInlineStatus(writing
      ? `${formatDuration(seconds)} elapsed · ${state.generationCharacters.toLocaleString()} SQL characters written`
      : `${formatDuration(seconds)} elapsed · preparing the first PostgreSQL token`);
    elements.modelStatus.textContent = writing
      ? `Writing PostgreSQL · ${seconds}s`
      : waiting
        ? `Still reading the schema · ${seconds}s`
        : `Reading the schema · ${seconds}s`;
    const generationStatus = writing
      ? `${state.generationCharacters} characters written.`
      : waiting
        ? "Use your model for a faster result while the local query continues."
        : "The model is preparing its first PostgreSQL token.";
    elements.modelProgressCopy.textContent = state.modelProof
      ? `The model replied “${state.modelProof}” · ${generationStatus}`
      : generationStatus;
    setServiceState(elements.modelLoader, elements.modelServiceState, "loading", "Writing");
    setActivity({
      source: "Assistant",
      title: writing ? "Writing your PostgreSQL" : "Reading the relevant schema",
      detail: writing
        ? `${state.generationCharacters} characters written · ${formatDuration(seconds)} elapsed.`
        : waiting
          ? `${formatDuration(seconds)} elapsed while the first token is prepared. Your model prompt is ready as a faster option.`
          : `${formatDuration(seconds)} elapsed · preparing the first PostgreSQL token.`,
      progress: null,
      log: false,
      key: "assistant:generation",
    });
    if (state.assistantPhase === "generate" || state.assistantPhase === "repair") {
      elements.builderTitle.textContent = state.assistantPhase === "repair"
        ? `Repairing your query · ${seconds}s`
        : writing
          ? `Writing your query · ${seconds}s · ${state.generationCharacters} characters`
          : waiting
            ? `Still reading your schema · ${seconds}s`
            : `Reading your schema · ${seconds}s`;
      setAssistantMessage(writing
        ? `Writing PostgreSQL · ${seconds}s · ${state.generationCharacters} characters`
        : waiting
          ? `Still reading the schema · ${seconds}s · Use your model for a faster result.`
          : `Reading the schema · ${seconds}s`);
      if (event.sql) {
        writeAgentSqlDraft(event.sql);
      } else if (state.sqlReplacementPending) {
        setAgentSqlStatus("Preparing Folio SQL", "preparing");
      }
    }
    return;
  }
  if (event.type === "model-progress") {
    const percent = Math.max(0, Math.min(100, event.percent || 0));
    setAssistantInlineStatus(`Downloading model · ${percent}%`);
    setServiceState(elements.modelLoader, elements.modelServiceState, "loading", "Downloading");
    elements.modelProgressBar.style.width = `${percent}%`;
    elements.modelStatus.textContent = `Downloading the local model · ${percent}%`;
    elements.modelProgressCopy.textContent = event.total
      ? `${formatBytes(event.loaded)} of ${formatBytes(event.total)}`
      : `${formatBytes(event.loaded)} downloaded`;
    setActivity({
      source: "Assistant",
      title: "Downloading the local model",
      detail: event.total
        ? `${formatBytes(event.loaded)} of ${formatBytes(event.total)} saved on this device.`
        : `${formatBytes(event.loaded)} saved on this device.`,
      progress: percent,
      log: false,
      key: "assistant:download",
    });
    const milestone = Math.floor(percent / 10) * 10;
    if (milestone > state.modelProgressMilestone) {
      state.modelProgressMilestone = milestone;
      appendActivity({
        source: "Assistant",
        title: `Model download ${milestone}%`,
        detail: event.total
          ? `${formatBytes(event.loaded)} of ${formatBytes(event.total)} saved locally.`
          : `${formatBytes(event.loaded)} saved locally.`,
        status: milestone === 100 ? "ready" : "info",
      });
    }
    return;
  }
  if (event.type !== "model-status") return;
  if (event.status === "ready") {
    stopModelWarmup();
    if (event.proof) state.modelProof = event.proof;
    state.modelReady = true;
    state.modelInfo = { ...(state.modelInfo || {}), ...event };
    const gpu = event.backend === "webgpu";
    setServiceState(
      elements.modelLoader,
      elements.modelServiceState,
      "ready",
      gpu ? "GPU" : "CPU",
    );
    elements.modelProgressBar.style.width = "100%";
    elements.modelStatus.textContent = "Local model ready";
    elements.modelProgressCopy.textContent = state.modelProof
      ? `Health check: “${state.modelProof}” · ${gpu ? `${event.gpuLayers || "GPU"} layers on WebGPU` : `${event.threads || 1} CPU threads`}.`
      : `${gpu ? "WebGPU" : "CPU"} runtime ready for local questions.`;
    setActivity({
      source: "Assistant",
      title: "Local assistant ready",
      detail: state.modelProof
        ? `Health check: “${state.modelProof}” · ${gpu ? `${event.gpuLayers || "All"} model layers on WebGPU` : `${event.threads || 1} CPU threads`}.`
        : `${gpu ? "WebGPU" : "CPU"} inference is ready for your question.`,
      status: "ready",
      progress: 100,
      details: event,
    });
    if (event.proof && state.assistantBusy && state.assistantPhase === "plan") {
      setAssistantInlineStatus("Model ready · preparing your answer");
      setAssistantMessage(`The local model replied “${event.proof}”. Writing your query next…`);
    }
    elements.modelLoadButton.textContent = "Model ready";
    elements.modelLoadButton.disabled = true;
  } else if (event.status === "loading") {
    setAssistantInlineStatus("Loading model into memory");
    setServiceState(elements.modelLoader, elements.modelServiceState, "loading", "Loading");
    elements.modelProgressBar.style.width = "100%";
    elements.modelStatus.textContent = "Starting the local model";
    elements.modelProgressCopy.textContent = "The download is complete. Folio is loading the model into memory.";
    setActivity({
      source: "Assistant",
      title: "Loading the model into memory",
      detail: "The download is complete. Folio is starting the local inference runtime.",
      progress: null,
    });
  } else if (event.status === "starting") {
    setAssistantInlineStatus("Starting the local model");
    setServiceState(elements.modelLoader, elements.modelServiceState, "loading", "Starting");
  } else if (event.status === "retrying-gpu") {
    setAssistantInlineStatus("Tuning WebGPU");
    setServiceState(elements.modelLoader, elements.modelServiceState, "loading", "Tuning GPU");
    elements.modelStatus.textContent = "Tuning WebGPU";
    elements.modelProgressCopy.textContent = "Folio is selecting a stable GPU layer count for this browser.";
    setActivity({
      source: "Runtime",
      title: "Tuning WebGPU",
      detail: "Trying a smaller GPU layer group on this browser.",
      progress: null,
    });
  } else if (event.status === "fallback") {
    setAssistantInlineStatus("Starting CPU mode");
    setServiceState(elements.modelLoader, elements.modelServiceState, "loading", "CPU fallback");
    elements.modelStatus.textContent = "Starting the CPU fallback";
    elements.modelProgressCopy.textContent = "The activity log contains the WebGPU startup details.";
    setActivity({
      source: "Runtime",
      title: "Starting the CPU fallback",
      detail: "The activity log contains the WebGPU startup details and suggested next steps.",
      progress: null,
    });
  } else if (event.status === "thinking") {
    const chat = event.mode === "chat" || state.assistantPhase === "chat";
    setAssistantInlineStatus(chat ? "Reading schema · preparing the first token" : "Reading schema · preparing SQL");
    setServiceState(
      elements.modelLoader,
      elements.modelServiceState,
      "loading",
      chat ? "Answering" : "Writing",
    );
    elements.modelStatus.textContent = chat ? "Answering about the schema" : "Writing PostgreSQL";
    elements.modelProgressCopy.textContent = "The model is working with this document's schema.";
  }
}

function handleReadableModelEvent(event) {
  const details = event.details || {};
  const at = event.at || new Date().toISOString();
  if (event.event === "load-start") {
    appendActivity({
      source: "Assistant",
      title: details.backend === "webgpu" ? "WebGPU selected" : "CPU runtime selected",
      detail: details.backend === "webgpu"
        ? details.gpuLayers >= 99
          ? "Full model offload requested for this GPU."
          : `${details.gpuLayers} model layers will run on this GPU.`
        : "The local model will use this processor.",
      status: "info",
      details,
      at,
    });
  } else if (event.event === "runtime-load-start") {
    setActivity({
      source: "Runtime",
      title: details.backend === "webgpu" ? "Starting WebGPU inference" : "Starting CPU inference",
      detail: `${details.contextSize || 0}-token context · ${details.gpuLayers >= 99 ? "full GPU offload" : `${details.gpuLayers || 0} GPU layers`}.`,
      progress: null,
      details,
    });
  } else if (event.event === "download-complete") {
    appendActivity({
      source: "Assistant",
      title: "Model download complete",
      detail: `${formatBytes(details.totalBytes)} is stored in this browser for later visits.`,
      status: "ready",
      details,
      at,
    });
  } else if (event.event === "runtime-load-complete") {
    appendActivity({
      source: "Runtime",
      title: "Inference runtime started",
      detail: details.gpuLayers
        ? `${details.gpuLayers} GPU layers · ${details.threads || 1} supporting CPU threads.`
        : `${details.threads || 1} CPU ${details.threads === 1 ? "thread" : "threads"}.`,
      status: "ready",
      details,
      at,
    });
  } else if (event.event === "warmup-start") {
    setActivity({
      source: "Assistant",
      title: "Checking the local model",
      detail: "Folio sent “Hi” and is waiting for the expected reply.",
      progress: null,
      details,
    });
  } else if (event.event === "warmup-response" || event.event === "warmup-fallback-response") {
    appendActivity({
      source: "Assistant",
      title: `Health check replied “${details.reply || "…"}”`,
      detail: `${details.usage?.total_tokens || 0} tokens processed locally.`,
      status: /^hi[.!]?$/i.test(details.reply || "") ? "ready" : "info",
      details,
      at,
    });
  } else if (event.event === "warmup-retry") {
    setActivity({
      source: "Assistant",
      title: "Repeating the health check",
      detail: "Folio is using a shorter instruction for a clear readiness signal.",
      progress: null,
      details,
    });
  } else if (event.event === "gpu-runtime-retry") {
    appendActivity({
      source: "Runtime",
      title: "WebGPU layer count adjusted",
      detail: "Folio is retrying with a smaller GPU workload.",
      status: "info",
      details,
      at,
    });
  } else if (event.event === "gpu-runtime-fallback") {
    appendActivity({
      source: "Runtime",
      title: "WebGPU startup stopped",
      detail: details.message || "The GPU runtime returned control during model startup.",
      status: "error",
      details,
      at,
    });
  } else if (event.event === "generation-start") {
    const chat = details.kind === "chat";
    setActivity({
      source: "Assistant",
      title: chat ? "Preparing a schema answer" : "Reading the relevant schema",
      detail: `${details.promptCharacters || 0} prompt characters · ${details.contextSize || 0}-token context.`,
      progress: null,
      details,
      key: chat ? "assistant:chat" : "assistant:generation",
    });
  } else if (event.event === "generation-complete") {
    const chat = details.kind === "chat";
    setActivity({
      source: "Assistant",
      title: chat ? "Schema answer written" : "PostgreSQL written",
      detail: chat
        ? `${details.outputCharacters || 0} answer characters are ready.`
        : `${details.sqlCharacters || 0} SQL characters are ready for PostgreSQL.`,
      status: "ready",
      progress: 100,
      details,
    });
  } else if (event.event === "request-error") {
    setActivity({
      source: "Assistant",
      title: "Local model needs attention",
      detail: details.message || "Open the activity log for the runtime details.",
      status: "error",
      details,
    });
  }
}

function logModelEvent(level, event, details, at = new Date().toISOString()) {
  const method = level === "error"
    ? "error"
    : level === "warn"
      ? "warn"
      : level === "debug"
        ? "debug"
        : "info";
  console[method](`[Folio model] ${at} ${event}`, details);
}

function startModelWarmup(elapsedMs = 0) {
  if (!state.modelWarmupTimer) {
    state.modelWarmupStartedAt = performance.now() - elapsedMs;
    state.modelWarmupTimer = window.setInterval(renderModelWarmup, 1_000);
  }
  renderModelWarmup();
}

function renderModelWarmup() {
  const seconds = Math.max(1, Math.round(
    (performance.now() - state.modelWarmupStartedAt) / 1_000,
  ));
  elements.modelStatus.textContent = `Checking the local model · ${seconds}s`;
  setAssistantInlineStatus(`Checking model · ${formatDuration(seconds)}`);
  elements.modelProgressCopy.textContent = "Folio sent “Hi.” and is waiting for the first reply.";
  setServiceState(elements.modelLoader, elements.modelServiceState, "loading", "Checking");
  setActivity({
    source: "Assistant",
    title: "Checking the local model",
    detail: `Waiting for “Hi” · ${formatDuration(seconds)} elapsed.`,
    progress: null,
    log: false,
    key: "assistant:warmup",
  });
  if (state.assistantBusy && state.assistantPhase === "plan") {
    elements.builderTitle.textContent = `Checking the local model · ${seconds}s`;
    setAssistantMessage(`Checking the local model · ${seconds}s`);
  }
}

function stopModelWarmup() {
  window.clearInterval(state.modelWarmupTimer);
  state.modelWarmupTimer = null;
  state.modelWarmupStartedAt = 0;
}

async function runModelGeneration(operation, payload) {
  state.generationCharacters = 0;
  state.generationSqlCharacters = 0;
  state.agentSqlReady = false;
  state.sqlReplacementPending = true;
  setAgentSqlStatus(
    operation === "repair" ? "Preparing revised Folio SQL" : "Preparing Folio SQL",
    "preparing",
  );
  const startedAt = performance.now();
  const renderHeartbeat = () => handleModelEvent({
    type: "model-generation",
    characters: state.generationCharacters,
    elapsedMs: Math.round(performance.now() - startedAt),
    sql: "",
  });
  renderHeartbeat();
  const timer = window.setInterval(renderHeartbeat, 1_000);
  try {
    return await llm.call(operation, payload);
  } finally {
    window.clearInterval(timer);
  }
}

async function runModelChat(payload) {
  state.generationCharacters = 0;
  state.generationAnswerCharacters = 0;
  state.generationSqlCharacters = 0;
  state.agentSqlReady = false;
  const startedAt = performance.now();
  const renderHeartbeat = () => handleModelEvent({
    type: "model-chat",
    characters: state.generationCharacters,
    elapsedMs: Math.round(performance.now() - startedAt),
    text: "",
  });
  renderHeartbeat();
  const timer = window.setInterval(renderHeartbeat, 1_000);
  try {
    return await llm.call("chat", payload);
  } finally {
    window.clearInterval(timer);
  }
}

async function getAssistantContext(question) {
  const matches = await search.call("contextSearch", { query: question });
  const tableNames = matches.slice(0, 6).map((match) => match.id);
  return dataStore.call("assistantContext", { tableNames, question });
}

async function prepareOwnModelPrompt() {
  const question = elements.askInput.value.trim();
  if (!question) {
    elements.askInput.focus();
    return;
  }

  elements.ownModelButton.disabled = true;
  elements.ownModelButton.textContent = "Building prompt…";
  try {
    const context = await getAssistantContext(question);
    elements.ownModelPrompt.value = buildExternalModelPrompt(context, question);
    elements.ownModelDialog.showModal();
    elements.ownModelPrompt.focus();
    elements.ownModelPrompt.select();
  } catch (error) {
    setAssistantMessage(`Folio needs another pass at this prompt. ${error.message}`, true);
  } finally {
    elements.ownModelButton.disabled = !state.catalog.length;
    elements.ownModelButton.textContent = "Use your model";
  }
}

function resetSchemaConversation(label, result) {
  state.schemaConversation = [];
  state.activeChatMessage = null;
  state.activeChatQuestion = "";
  state.queryRecoveryAvailable = false;
  elements.schemaChat.replaceChildren();
  appendChatMessage(
    "assistant",
    `${label || state.documentLabel} is ready with ${result.catalog.length.toLocaleString()} tables and ${result.valueCount.toLocaleString()} values. Ask how its records connect, what a field means, or which report could reveal a pattern.`,
  );
  elements.assistantFeedback.hidden = true;
  elements.assistantAnswer.hidden = true;
}

function appendChatMessage(role, text, { evidence = [] } = {}) {
  const message = document.createElement("article");
  message.className = `chat-message ${role}`;
  const body = document.createElement("div");
  if (role === "assistant") {
    const avatar = document.createElement("span");
    avatar.className = "chat-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "F";
    const name = document.createElement("strong");
    name.textContent = "Folio";
    body.append(name);
    message.append(avatar, body);
  } else {
    message.append(body);
  }
  const copy = document.createElement("p");
  copy.textContent = text;
  body.append(copy);
  decorateChatMessage(message, { evidence });
  elements.schemaChat.append(message);
  elements.schemaChat.scrollTop = elements.schemaChat.scrollHeight;
  return message;
}

function updateChatMessage(message, text) {
  const copy = message?.querySelector("p");
  if (copy) copy.textContent = text;
  elements.schemaChat.scrollTop = elements.schemaChat.scrollHeight;
}

function decorateChatMessage(message, { evidence = [] } = {}) {
  const body = message?.querySelector("div");
  if (!body) return;
  body.querySelector(".chat-evidence")?.remove();
  if (evidence.length) {
    const list = document.createElement("div");
    list.className = "chat-evidence";
    list.setAttribute("aria-label", "Schema used for this answer");
    for (const table of [...new Set(evidence)].slice(0, 4)) {
      const chip = document.createElement("span");
      chip.textContent = friendlyName(table);
      chip.title = table;
      list.append(chip);
    }
    body.append(list);
  }
}

function resetAssistantButtons() {
  setAssistantInlineStatus("");
  const ready = Boolean(state.catalog.length);
  elements.chatButton.disabled = !ready;
  elements.chatButton.innerHTML = 'Ask Folio <i aria-hidden="true">→</i>';
  elements.askButton.hidden = !state.queryRecoveryAvailable;
  elements.askButton.disabled = !ready || !state.queryRecoveryAvailable;
  elements.askButton.textContent = "Retry query";
  elements.ownModelButton.disabled = !ready;
}

function stopAssistantGeneration() {
  state.assistantCancelled = true;
  elements.chatButton.disabled = true;
  elements.askButton.disabled = true;
  elements.ownModelButton.disabled = true;
  const chat = state.assistantMode === "chat";
  setAssistantInlineStatus("Stopping the local model…");
  if (chat) elements.chatButton.textContent = "Stopping…";
  else elements.askButton.textContent = "Stopping…";
  llm.stop();
  state.modelReady = false;
  state.modelLoading = null;
  state.modelInfo = null;
  stopModelWarmup();
  setServiceState(elements.modelLoader, elements.modelServiceState, "idle", "Cached");
  elements.modelStatus.textContent = "Local assistant paused";
  elements.modelProgressCopy.textContent = "The model stays cached and will restart with your next question.";
  elements.modelLoadButton.disabled = false;
  elements.modelLoadButton.textContent = "Restart";
  setActivity({
    source: "Assistant",
    title: chat ? "Stopping this answer" : "Stopping query generation",
    detail: chat
      ? "Your conversation remains here."
      : "Folio’s current PostgreSQL draft remains visible.",
    progress: null,
  });
}

async function chatWithFolio(event) {
  event?.preventDefault();
  if (state.assistantBusy) {
    stopAssistantGeneration();
    return;
  }
  const question = elements.askInput.value.trim();
  if (!question || !state.catalog.length) {
    elements.askInput.focus();
    return;
  }
  const reportWasReady = Boolean(state.report);

  const history = [...state.schemaConversation];
  appendChatMessage("user", question);
  const responseMessage = appendChatMessage(
    "assistant",
    "Finding the relevant records and relationships…",
  );
  state.activeChatMessage = responseMessage;
  state.activeChatQuestion = question;
  state.assistantBusy = true;
  state.assistantCancelled = false;
  state.assistantPhase = "chat";
  state.assistantMode = "chat";
  state.queryRecoveryAvailable = false;
  state.generationCharacters = 0;
  state.generationAnswerCharacters = 0;
  state.generationSqlCharacters = 0;
  state.assistantSqlStarted = false;
  state.agentSqlReady = false;
  state.sqlReplacementPending = true;
  state.sqlVersion += 1;
  state.modelRawResponse = "";
  elements.assistantFeedback.hidden = false;
  if (!reportWasReady) {
    elements.rowCount.textContent = "Working";
    elements.resultWrap.replaceChildren(emptyResult("Preparing your report…", "↳"));
  }
  elements.builderTitle.textContent = "Answering and writing your query";
  elements.queryPrompt.hidden = false;
  elements.queryPrompt.textContent = question;
  elements.agentSqlOutput.setAttribute("aria-busy", "true");
  setAgentSqlStatus("Preparing Folio SQL", "preparing");
  resetAssistantStages();
  setAssistantStage("schema");
  elements.chatButton.disabled = false;
  elements.chatButton.textContent = "Stop";
  setAssistantInlineStatus("Finding the relevant schema");
  elements.askButton.disabled = true;
  elements.ownModelButton.disabled = false;
  syncQueryAndReportControls();
  setActivity({
    source: "Assistant",
    title: "Finding the relevant schema",
    detail: "Matching your question to records, fields, and relationships.",
    progress: 10,
  });

  try {
    const context = await getAssistantContext(question);
    assertAssistantActive();
    completeAssistantStage("schema");
    setAssistantStage("plan");
    const postgresReady = ensurePostgresData().then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    updateChatMessage(responseMessage, "Starting the local model with this schema…");
    await prepareModel();
    assertAssistantActive();
    const { proposal: rawProposal } = await runModelChat({ question, context, history });
    assertAssistantActive();
    const proposal = validateProposal(rawProposal);
    updateChatMessage(responseMessage, proposal.answer);
    decorateChatMessage(responseMessage, {
      evidence: proposal.tables.length
        ? proposal.tables
        : context.tables?.map((table) => table.name) || [],
    });
    state.schemaConversation.push(
      { role: "user", content: question },
      { role: "assistant", content: proposal.answer },
    );
    state.schemaConversation = state.schemaConversation.slice(-8);
    const finalProposal = await runAssistantProposal({
      question,
      context,
      proposal,
      postgresReady,
    });
    updateChatMessage(responseMessage, finalProposal.answer);
    decorateChatMessage(responseMessage, {
      evidence: finalProposal.tables.length
        ? finalProposal.tables
        : context.tables?.map((table) => table.name) || [],
    });
    setActivity({
      source: "Assistant",
      title: "Answer and report ready",
      detail: "The query ran automatically and remains ready to run again.",
      status: "ready",
      progress: 100,
    });
  } catch (error) {
    const cancelled = state.assistantCancelled || error.name === "AbortError"
      || /operation aborted/i.test(error.message);
    const hasDraft = state.assistantSqlStarted && Boolean(elements.agentSqlOutput.value.trim());
    const keptPreviousSql = !state.assistantSqlStarted && Boolean(elements.agentSqlOutput.value.trim());
    state.agentSqlReady = hasDraft && isRunnableSql(elements.agentSqlOutput.value);
    state.queryRecoveryAvailable = !cancelled;
    updateChatMessage(
      responseMessage,
      cancelled
        ? "Answer stopped. Ask another question when you are ready."
        : hasDraft
          ? `The model’s exact SQL is visible below. Review this draft: ${error.message}`
          : `Folio needs another pass at this question. ${error.message}`,
    );
    if (!cancelled) markAssistantError();
    elements.builderTitle.textContent = hasDraft
      ? "Review this query draft"
      : keptPreviousSql
        ? "Previous query kept"
        : "Query needs another pass";
    if (!state.report) {
      elements.rowCount.textContent = hasDraft ? "Query draft" : keptPreviousSql ? "Previous query" : "Query error";
      elements.resultWrap.replaceChildren(emptyResult(
        hasDraft
          ? "Copy this draft to your editor or use Retry query."
          : keptPreviousSql
            ? "Folio’s previous SQL remains ready to run."
            : "Use Retry query to generate the report again.",
        "!",
      ));
    }
    setAgentSqlStatus(
      state.agentSqlReady
        ? "Draft ready to run"
        : hasDraft
          ? "Review Folio SQL"
          : keptPreviousSql
            ? "Previous Folio SQL kept"
            : "Folio SQL needs attention",
      state.agentSqlReady || keptPreviousSql ? "ready" : "error",
    );
    setActivity({
      source: "Assistant",
      title: cancelled ? "Answer stopped" : hasDraft ? "Folio SQL needs review" : "Schema answer needs attention",
      detail: cancelled ? "Your conversation remains here." : error.message,
      status: cancelled ? "ready" : "error",
      progress: cancelled ? 100 : null,
      details: cancelled ? null : { message: error.message, output: error.output || "" },
    });
  } finally {
    state.assistantBusy = false;
    state.assistantCancelled = false;
    state.assistantPhase = "idle";
    state.sqlReplacementPending = false;
    state.activeChatMessage = null;
    state.activeChatQuestion = "";
    elements.agentSqlOutput.removeAttribute("aria-busy");
    resetAssistantButtons();
    syncQueryAndReportControls();
  }
}

function matchesDiscogsOverview(question, context) {
  const words = String(question).toLowerCase();
  const hasDemoSchema = context?.tables?.some(
    (table) => table.name === "discogs_releases__release",
  ) || state.catalog.some((table) => table.name === "discogs_releases__release");
  if (!hasDemoSchema || !words.includes("artist") || !words.includes("release")) return false;
  return ["electronic", "track", "label", "style"]
    .filter((term) => words.includes(term)).length >= 2;
}

async function knownReportProposal(question, context) {
  if (!matchesDiscogsOverview(question, context)) return null;
  const sql = await dataStore.call("sql", {
    plan: {
      table: "discogs_releases__release",
      operation: "discogs-artist-overview",
      fields: [],
      filter: { field: "", operator: "equals", value: "" },
    },
  });
  return {
    sql,
    answer: "This report uses WITH RECURSIVE to follow nested records and compare Electronic artists across releases, tracks, labels, and styles.",
    tables: [
      "discogs_releases__release",
      "discogs_releases__release__artists__artist",
      "discogs_releases__release__labels__label",
      "discogs_releases__release__styles__style",
      "discogs_releases__release__tracklist__track",
    ],
    assumptions: ["Electronic is matched through each release's genre records."],
  };
}

async function checkBrowser() {
  try {
    const result = await capabilities.call("check", { isolated: window.crossOriginIsolated });
    const threadsReady = result.isolated && result.sharedMemory;
    const threads = Math.max(1, Math.floor(result.hardwareConcurrency / 2));
    const runtimeStatus = result.webgpuReady ? "ready" : threadsReady ? "ready" : "active";
    setServiceState(
      elements.browserCheck,
      elements.runtimeServiceState,
      runtimeStatus,
      result.webgpuReady ? "GPU" : threadsReady ? `${threads} threads` : "1 thread",
    );
    elements.browserCheck.classList.toggle("fallback", !result.webgpuReady);
    elements.browserCheckTitle.textContent = result.webgpuReady
      ? "WebGPU ready"
      : threadsReady
        ? "Threaded CPU available"
        : "CPU compatibility available";
    elements.browserCheckStatus.textContent = result.webgpuReady
      ? `${result.browser} passed Folio’s local GPU compute check.`
      : threadsReady
        ? `${result.browser} can use ${threads} local CPU threads.`
        : `${result.browser} can use the single-thread local runtime.`;
    elements.browserCheckGuidance.replaceChildren(
      ...result.guidance.map((instruction) => {
        const item = document.createElement("li");
        item.textContent = instruction;
        return item;
      }),
    );
    elements.browserCheck.classList.toggle("needs-guidance", result.guidance.length > 0);
    elements.browserCheckGuidance.hidden = result.guidance.length === 0;
    appendActivity({
      source: "Runtime",
      title: result.webgpuReady ? "GPU compute check passed" : threadsReady ? "CPU threads ready" : "CPU compatibility ready",
      detail: result.webgpuReady
        ? `${result.browser} supports 16-bit WebGPU compute for the local model.`
        : `${result.browser} has ${threadsReady ? threads : 1} local CPU ${threadsReady && threads !== 1 ? "threads" : "thread"} available.`,
      status: result.webgpuReady || threadsReady ? "ready" : "info",
      details: result,
    });
  } catch (error) {
    setServiceState(elements.browserCheck, elements.runtimeServiceState, "active", "CPU");
    elements.browserCheck.classList.add("fallback");
    elements.browserCheck.classList.remove("needs-guidance");
    elements.browserCheckTitle.textContent = "CPU compatibility available";
    elements.browserCheckStatus.textContent = "Folio can start the local model with the local CPU runtime.";
    elements.browserCheckGuidance.hidden = true;
    appendActivity({
      source: "Runtime",
      title: "Browser check needs attention",
      detail: error.message,
      status: "error",
      details: { message: error.message },
    });
  }
}

async function askFolio(event) {
  event?.preventDefault();
  if (state.assistantBusy) {
    stopAssistantGeneration();
    return;
  }
  const question = elements.askInput.value.trim();
  if (!question) {
    elements.askInput.focus();
    return;
  }
  const reportWasReady = Boolean(state.report);

  state.assistantBusy = true;
  state.assistantCancelled = false;
  state.assistantPhase = "schema";
  state.assistantMode = "query";
  state.assistantSqlStarted = false;
  state.sqlReplacementPending = true;
  state.sqlVersion += 1;
  state.generationCharacters = 0;
  state.generationAnswerCharacters = 0;
  state.generationSqlCharacters = 0;
  state.agentSqlReady = false;
  state.modelRawResponse = "";
  elements.assistantFeedback.hidden = false;
  if (!reportWasReady) {
    elements.rowCount.textContent = "Working";
    elements.resultWrap.replaceChildren(emptyResult(
      "Your report will appear here as soon as PostgreSQL checks the generated query.",
      "↳",
    ));
  }
  elements.askButton.disabled = false;
  elements.askButton.textContent = "Stop";
  setAssistantInlineStatus("Finding the relevant schema");
  elements.chatButton.disabled = true;
  elements.ownModelButton.disabled = false;
  elements.builderTitle.textContent = "Writing your query";
  elements.queryPrompt.hidden = false;
  elements.queryPrompt.textContent = question;
  elements.agentSqlOutput.setAttribute("aria-busy", "true");
  setAgentSqlStatus("Preparing Folio SQL", "preparing");
  syncQueryAndReportControls();
  resetAssistantStages();
  setAssistantStage("schema");
  setAssistantMessage("Finding the tables and fields that match your question…");
  setActivity({
    source: "Assistant",
    title: "Finding the matching schema",
    detail: "Searching element names, fields, and relationships for your question.",
    progress: 8,
  });

  try {
    const context = await getAssistantContext(question);
    assertAssistantActive();
    completeAssistantStage("schema");
    setAssistantStage("plan");
    state.assistantPhase = "plan";
    setAssistantMessage("Planning the report from the inferred schema…");
    setActivity({
      source: "Assistant",
      title: "Planning your report",
      detail: `${context.tables?.length || context.tableCount || "Relevant"} inferred tables are in the model context.`,
      progress: 20,
      details: {
        contextCharacters: safeJson(context).length,
        tableCount: context.tables?.length || context.tableCount || null,
      },
    });

    const postgresReady = ensurePostgresData().then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    await prepareModel();
    assertAssistantActive();
    state.assistantPhase = "generate";
    setAssistantMessage("Writing PostgreSQL from this document’s schema…");
    setActivity({
      source: "Assistant",
      title: "Writing your PostgreSQL",
      detail: "The local model is translating your question into joins and filters.",
      progress: null,
      key: "assistant:generation",
    });
    let proposal;
    let repairAttempts = 0;
    let usedKnownReport = false;
    try {
      ({ proposal } = await runModelGeneration("ask", { question, context }));
      proposal = validateProposal(proposal);
    } catch (generationError) {
      if (state.assistantCancelled || generationError.name === "AbortError") {
        throw generationError;
      }
      completeAssistantStage("plan");
      setAssistantStage("repair");
      state.assistantPhase = "repair";
      elements.builderTitle.textContent = "Refining the query draft";
      const knownReport = await knownReportProposal(question, context);
      if (knownReport) {
        usedKnownReport = true;
        proposal = validateProposal(knownReport);
        setAssistantMessage("Folio matched this question to the tested Discogs report. Running it now…");
        setActivity({
          source: "Assistant",
          title: "Using the tested Discogs report",
          detail: "The generated draft missed a schema constraint. Folio selected the verified relationship query and will run it automatically.",
          progress: 55,
          details: { message: generationError.message },
        });
      } else {
        const draft = state.assistantSqlStarted ? elements.agentSqlOutput.value.trim() : "";
        if (!draft) throw generationError;
        setAssistantMessage(`The first draft returned: ${generationError.message} Folio is refining it…`);
        setActivity({
          source: "Assistant",
          title: "Refining the query draft",
          detail: generationError.message,
          progress: null,
          details: {
            message: generationError.message,
            modelResponse: generationError.output || state.modelRawResponse || "",
          },
        });
        const repaired = await runModelGeneration("repair", {
          question,
          proposal: {
            sql: draft,
            answer: "Query draft",
            tables: [],
            assumptions: [],
          },
          error: { message: generationError.message },
          context,
        });
        repairAttempts += 1;
        proposal = validateProposal(repaired.proposal);
      }
      completeAssistantStage("repair");
    }
    await runAssistantProposal({
      question,
      context,
      proposal,
      postgresReady,
      repairAttempts,
      usedKnownReport,
    });
    state.queryRecoveryAvailable = false;
  } catch (error) {
    const cancelled = state.assistantCancelled || error.name === "AbortError" || /operation aborted/i.test(error.message);
    const hasDraft = state.assistantSqlStarted && Boolean(elements.agentSqlOutput.value.trim());
    const keptPreviousSql = !state.assistantSqlStarted && Boolean(elements.agentSqlOutput.value.trim());
    state.agentSqlReady = hasDraft && isRunnableSql(elements.agentSqlOutput.value);
    if (cancelled) {
      elements.builderTitle.textContent = hasDraft
        ? "Query generation stopped · draft ready"
        : keptPreviousSql
          ? "Query generation stopped · previous query kept"
          : "Query generation stopped";
      setAssistantMessage(hasDraft
        ? "Generation stopped. Folio’s current PostgreSQL draft remains visible."
        : keptPreviousSql
          ? "Generation stopped. Folio’s previous query remains available."
          : "Generation stopped. Ask another question when you are ready.");
    } else {
      state.queryRecoveryAvailable = true;
      markAssistantError();
      elements.builderTitle.textContent = hasDraft
        ? "Review this query draft"
        : keptPreviousSql
          ? "Previous query kept"
          : "Query needs another pass";
      showAssistantFailure(error.message, error.output || state.modelRawResponse);
    }
    if (!state.report) {
      elements.rowCount.textContent = hasDraft ? "Query draft" : keptPreviousSql ? "Previous query" : "Query error";
      elements.resultWrap.replaceChildren(emptyResult(
        hasDraft
          ? "Review Folio’s exact draft below, or copy it into your editor."
          : keptPreviousSql
            ? "Folio’s previous SQL remains ready to run."
            : "The activity log and model response contain the details for this attempt.",
        "!",
      ));
    }
    setAgentSqlStatus(
      state.agentSqlReady
        ? "Draft ready to run"
        : hasDraft
          ? "Review Folio SQL"
          : keptPreviousSql
            ? "Previous Folio SQL kept"
            : "Folio SQL needs attention",
      state.agentSqlReady || keptPreviousSql ? "ready" : "error",
    );
    setActivity(cancelled ? {
      source: "Assistant",
      title: "Query generation stopped",
      detail: hasDraft
        ? "Folio’s current PostgreSQL draft remains visible."
        : keptPreviousSql
          ? "Folio’s previous PostgreSQL remains ready to run."
          : "Ask another question whenever you are ready.",
      status: "ready",
      progress: 100,
    } : {
      source: "Assistant",
      title: "Query needs attention",
      detail: error.message,
      status: "error",
      details: {
        message: error.message,
        modelResponse: error.output || state.modelRawResponse || "",
      },
    });
  } finally {
    state.assistantBusy = false;
    state.assistantPhase = "idle";
    state.sqlReplacementPending = false;
    elements.agentSqlOutput.removeAttribute("aria-busy");
    resetAssistantButtons();
    state.assistantCancelled = false;
    syncQueryAndReportControls();
  }
}

async function runAssistantProposal({
  question,
  context,
  proposal: initialProposal,
  postgresReady,
  repairAttempts: initialRepairAttempts = 0,
  usedKnownReport: initialUsedKnownReport = false,
}) {
  let proposal = validateProposal(initialProposal);
  let repairAttempts = initialRepairAttempts;
  let usedKnownReport = initialUsedKnownReport;

  showProposal(proposal);
  elements.builderTitle.textContent = "Query written · preparing result";
  setAgentSqlStatus("Checking with PostgreSQL", "preparing");
  completeAssistantStage("plan");
  setAssistantStage("check");
  state.assistantPhase = "postgres";
  setAssistantMessage(state.postgresStatus || "Preparing PostgreSQL…");
  setActivity({
    source: "PostgreSQL",
    title: "Preparing the local database",
    detail: "Loading the inferred records while keeping the SQL editable.",
    progress: null,
  });
  const postgresState = await postgresReady;
  assertAssistantActive();
  if (postgresState.error) throw postgresState.error;

  state.assistantPhase = "check";
  elements.builderTitle.textContent = "Running your query";
  setAssistantMessage("Running the query with PostgreSQL…");
  setActivity({
    source: "PostgreSQL",
    title: "Running your query",
    detail: "The report updates when PostgreSQL completes the joins.",
    progress: null,
  });
  let result = await postgres.exec(proposal.sql);
  while (result.kind === "error" && repairAttempts < 2) {
    completeAssistantStage("check");
    setAssistantStage("repair");
    state.assistantPhase = "repair";
    elements.builderTitle.textContent = "Repairing your query";
    const knownReport = usedKnownReport ? null : await knownReportProposal(question, context);
    if (knownReport) {
      usedKnownReport = true;
      proposal = validateProposal(knownReport);
      setAssistantMessage("Using the tested Discogs report…");
      setActivity({
        source: "Assistant",
        title: "Using the tested Discogs report",
        detail: `The first query returned: ${result.text}`,
        progress: 70,
        details: result.error || { message: result.text },
      });
    } else {
      repairAttempts += 1;
      setAssistantMessage(`PostgreSQL returned: ${result.text} Repairing the query…`);
      setActivity({
        source: "Assistant",
        title: "Repairing the PostgreSQL",
        detail: result.text,
        progress: null,
        details: result.error || { message: result.text },
      });
      const repaired = await runModelGeneration("repair", {
        question,
        proposal,
        error: result.error || { message: result.text },
        context,
      });
      proposal = validateProposal(repaired.proposal);
    }
    showProposal(proposal);
    completeAssistantStage("repair");
    setAssistantStage("check");
    state.assistantPhase = "check";
    result = await postgres.exec(proposal.sql);
  }

  if (result.kind === "error") throw new Error(result.text);
  completeAssistantStage("check");
  completeAssistantStage("repair");
  state.reportSql = proposal.sql;
  state.reportQuestion = question;
  renderPostgresResult(result);
  showProposalAnswer(proposal);
  elements.builderTitle.textContent = "Query ready · report updated";
  setAgentSqlStatus("Ready to run", "ready");
  return proposal;
}

function assertAssistantActive() {
  if (!state.assistantCancelled) return;
  const error = new Error("Generation stopped.");
  error.name = "AbortError";
  throw error;
}

function showProposal(proposal) {
  writeAgentSqlDraft(proposal.sql, { ready: true });
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

  const loading = (async () => {
    state.postgresProgressMilestone = -1;
    setPostgresStatus("Starting local PostgreSQL", 0);
    await postgres.prepareDocument();
    const schemaSql = await dataStore.call("postgresSchema");
    const useCopy = postgres.supportsCopy();
    const singleCopy = useCopy && postgres.engine === "single";
    appendActivity({
      source: "PostgreSQL",
      title: useCopy ? "COPY loader ready" : "Insert loader ready",
      detail: useCopy
        ? singleCopy
          ? "Preparing transferable row chunks for one PostgreSQL COPY pass."
          : "Importing document rows with PostgreSQL COPY in 50,000-row chunks."
        : "Importing document rows in 10,000-row compatibility batches.",
      status: "info",
    });
    let offset = 0;
    const copySql = "COPY nodes (id, parent_id, name, path, data_type, value) FROM STDIN WITH (FORMAT text);";
    if (singleCopy) {
      const buffers = [];
      while (true) {
        if (generation !== state.documentGeneration) {
          throw new Error("A new document is loading. Run this query again when it is ready.");
        }
        const batch = await dataStore.call(
          "postgresCopyBuffer",
          { offset, limit: 100_000 },
        );
        if (batch.buffer.byteLength) buffers.push(batch.buffer);
        offset = batch.nextOffset;
        const percent = batch.total ? Math.round((offset / batch.total) * 100) : 100;
        setPostgresStatus(
          `Preparing document rows · ${percent}% — ${offset.toLocaleString()} of ${batch.total.toLocaleString()}`,
          percent,
        );
        if (batch.done) break;
      }
      setPostgresStatus("Loading document rows into PostgreSQL · starting", null);
      const loadStartedAt = performance.now();
      const loadTimer = window.setInterval(() => {
        const seconds = Math.max(1, Math.round((performance.now() - loadStartedAt) / 1_000));
        setPostgresStatus(`Loading document rows into PostgreSQL · ${seconds}s`, null);
      }, 1_000);
      try {
        assertPostgresResult(await postgres.loadSingle(schemaSql, copySql, buffers));
      } finally {
        window.clearInterval(loadTimer);
      }
      setPostgresStatus(
        `Document rows loaded · 100% — ${offset.toLocaleString()} of ${offset.toLocaleString()}`,
        100,
      );
    } else {
      assertPostgresResult(await postgres.exec(schemaSql));
      while (true) {
        if (generation !== state.documentGeneration) {
          throw new Error("A new document is loading. Run this query again when it is ready.");
        }
        const batch = await dataStore.call(
          useCopy ? "postgresCopyBatch" : "postgresBatch",
          { offset, limit: useCopy ? 50_000 : 10_000 },
        );
        if (useCopy && batch.data) {
          assertPostgresResult(await postgres.copy(copySql, [batch.data]));
        } else if (batch.sql) assertPostgresResult(await postgres.exec(batch.sql));
        offset = batch.nextOffset;
        const percent = batch.total ? Math.round((offset / batch.total) * 100) : 100;
        setPostgresStatus(
          `Loading document rows · ${percent}% — ${offset.toLocaleString()} of ${batch.total.toLocaleString()}`,
          percent,
        );
        if (batch.done) break;
      }
    }
    setPostgresStatus("Building PostgreSQL indexes · starting", null);
    const indexStartedAt = performance.now();
    const indexTimer = window.setInterval(() => {
      const seconds = Math.max(1, Math.round((performance.now() - indexStartedAt) / 1_000));
      setPostgresStatus(`Building PostgreSQL indexes · ${seconds}s`, null);
    }, 1_000);
    try {
      assertPostgresResult(await postgres.exec(await dataStore.call("postgresIndexes")));
    } finally {
      window.clearInterval(indexTimer);
    }
    state.postgresReadyGeneration = generation;
    setPostgresStatus("PostgreSQL ready", 100);
  })();
  state.postgresLoading = loading;

  try {
    await loading;
  } catch (error) {
    if (generation !== state.documentGeneration) return;
    elements.postgresRuntimeStatus.textContent = error.message;
    setServiceState(elements.postgresRuntime, elements.postgresRuntimeState, "error");
    setActivity({
      source: "PostgreSQL",
      title: "PostgreSQL needs attention",
      detail: error.message,
      status: "error",
      details: { message: error.message },
    });
    throw error;
  } finally {
    if (state.postgresLoading === loading) state.postgresLoading = null;
  }
}

function assertPostgresResult(result) {
  if (result.kind === "error") throw new Error(result.text);
  return result;
}

function handlePostgresEvent(event) {
  const at = new Date().toISOString();
  const details = summarizePostgresEvent(event);
  const method = event.type === "error" ? "error" : event.type === "status" ? "debug" : "info";
  console[method](`[Folio PostgreSQL] ${at} ${event.type}`, details);
  if (event.type !== "status") return;
  if (event.state === "fetching") setPostgresStatus("Starting local PostgreSQL", 0);
}

function summarizePostgresEvent(event) {
  if (event.type === "result") {
    return {
      id: event.id,
      engine: event.engine,
      durationMs: event.ms,
      exitCode: event.exitCode,
      command: event.wire?.tag || null,
      rows: event.wire?.rows?.length || 0,
      error: event.wire?.error?.message || null,
      stderr: event.stderr ? event.stderr.slice(0, 600) : "",
    };
  }
  return {
    id: event.id,
    engine: event.engine,
    text: event.text,
    message: event.message,
    build: event.build,
    persist: event.persist,
    restored: event.restored,
  };
}

function setPostgresStatus(message, progress = undefined) {
  state.postgresStatus = message;
  elements.postgresRuntimeStatus.textContent = message;
  const ready = message === "PostgreSQL ready";
  setServiceState(
    elements.postgresRuntime,
    elements.postgresRuntimeState,
    ready ? "ready" : "loading",
    ready ? "Ready" : message.includes("indexes") ? "Indexing" : "Loading",
  );
  if (state.assistantPhase === "postgres") setAssistantMessage(message);

  const title = ready
    ? "PostgreSQL ready"
    : message.includes("indexes")
      ? "Building relationship indexes"
      : message.includes("Loading document rows")
        ? "Loading document rows"
        : "Starting local PostgreSQL";
  setActivity({
    source: "PostgreSQL",
    title,
    detail: ready
      ? "The local database is ready for joins, filters, and aggregations."
      : message,
    status: ready ? "ready" : "working",
    progress,
    log: ready || progress === 0 || progress === null,
    details: { message, progress },
    key: `postgres:${title}`,
  });

  if (Number.isFinite(progress) && !ready) {
    const milestone = Math.floor(progress / 25) * 25;
    if (milestone > state.postgresProgressMilestone) {
      state.postgresProgressMilestone = milestone;
      appendActivity({
        source: "PostgreSQL",
        title: `Document rows loaded · ${milestone}%`,
        detail: message,
        status: "info",
      });
    }
  }
}

function renderPostgresResult(result) {
  if (result.kind === "table") {
    renderTableResult(result.columns, result.rows);
    return;
  }
  clearReport();
  elements.rowCount.textContent = "Complete";
  elements.resultWrap.replaceChildren(emptyResult(result.text || "Query complete.", "✓"));
  setActivity({
    source: "PostgreSQL",
    title: "Query complete",
    detail: result.text || "PostgreSQL completed the query.",
    status: "ready",
    progress: 100,
  });
}

function renderTableResult(
  columns,
  rows,
  { announce = true, documentLabel = state.documentLabel } = {},
) {
  state.report = {
    columns: [...columns],
    rows: rows.map((row) => Array.isArray(row) ? [...row] : columns.map((column) => row[column])),
  };
  state.reportDocumentLabel = documentLabel || "document";
  syncQueryAndReportControls();
  elements.rowCount.textContent = `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  if (!rows.length) {
    elements.resultWrap.replaceChildren(emptyResult(
      "Your report is ready with zero matching rows. Adjust the query or filter to widen it.",
      "◇",
    ));
    if (announce) {
      setActivity({
        source: "Report",
        title: "Report ready",
        detail: "The query completed with zero matching rows. CSV headers are ready to download.",
        status: "ready",
        progress: 100,
      });
    }
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
  if (announce) {
    setActivity({
      source: "Report",
      title: "Report ready",
      detail: `${rows.length} ${rows.length === 1 ? "row is" : "rows are"} ready to explore or download as CSV.`,
      status: "ready",
      progress: 100,
    });
  }
}

function renderQueryError(message) {
  clearReport();
  elements.rowCount.textContent = "Query error";
  elements.resultWrap.replaceChildren(emptyResult(message, "!"));
  setActivity({
    source: "Report",
    title: "Query needs attention",
    detail: message,
    status: "error",
    details: { message },
  });
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

function setAssistantInlineStatus(copy) {
  const visible = Boolean(copy) && state.assistantBusy;
  elements.assistantInlineStatus.hidden = !visible;
  elements.assistantInlineStatusCopy.textContent = visible
    ? `${copy} · Keep this tab open while Folio writes.`
    : "";
}

function showAssistantFailure(message, modelResponse) {
  setAssistantMessage(`Folio needs another pass at this question. ${message}`, true);
  if (!modelResponse) return;
  const heading = document.createElement("strong");
  heading.textContent = "Model response";
  const response = document.createElement("pre");
  response.className = "assistant-model-response";
  response.textContent = modelResponse;
  elements.assistantAnswer.append(heading, response);
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

function setActivity({
  source = "Folio",
  title,
  detail = "",
  status = "working",
  progress = null,
  log = true,
  details = null,
  key = `${source}:${title}`,
}) {
  elements.activityTitle.textContent = title;
  elements.activityDetail.textContent = detail;
  elements.activityCurrent.dataset.state = status;

  const working = status === "working";
  if (working) {
    if (state.activityKey !== key || !state.activityStartedAt) {
      state.activityKey = key;
      state.activityStartedAt = performance.now();
    }
    startActivityClock();
  } else {
    renderActivityElapsed();
    stopActivityClock();
    state.activityKey = "";
  }

  elements.activityMeter.classList.toggle("indeterminate", working && progress === null);
  if (Number.isFinite(progress)) {
    elements.activityProgressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  } else if (status === "ready") {
    elements.activityProgressBar.style.width = "100%";
  } else if (!working) {
    elements.activityProgressBar.style.width = "0%";
  }

  const signature = `${source}:${title}:${status}`;
  if (log && signature !== state.activitySignature) {
    state.activitySignature = signature;
    appendActivity({ source, title, detail, status, details });
  }
}

function startActivityClock() {
  elements.activityElapsed.hidden = false;
  if (!state.activityTimer) {
    state.activityTimer = window.setInterval(renderActivityElapsed, 1_000);
  }
  renderActivityElapsed();
}

function stopActivityClock() {
  window.clearInterval(state.activityTimer);
  state.activityTimer = null;
}

function renderActivityElapsed() {
  if (!state.activityStartedAt) {
    elements.activityElapsed.hidden = true;
    return;
  }
  const seconds = Math.max(0, Math.round((performance.now() - state.activityStartedAt) / 1_000));
  elements.activityElapsed.hidden = false;
  elements.activityElapsed.textContent = formatDuration(seconds);
  elements.activityElapsed.dateTime = `PT${seconds}S`;
}

function appendActivity({
  source = "Folio",
  title,
  detail = "",
  status = "info",
  details = null,
  at = new Date().toISOString(),
}) {
  state.activityEvents.push({ source, title, detail, status, details, at });
  state.activityEvents = state.activityEvents.slice(-80);
  renderActivityLog();
}

function renderActivityLog() {
  elements.activityCount.textContent = String(state.activityEvents.length);
  elements.activityLog.replaceChildren();
  for (const event of [...state.activityEvents].reverse()) {
    const item = document.createElement("li");
    item.className = `activity-event ${event.status === "ready" ? "success" : event.status}`;
    const time = document.createElement("time");
    time.dateTime = event.at;
    time.textContent = new Date(event.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const source = document.createElement("span");
    source.textContent = event.source;
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = event.title;
    copy.append(title);
    if (event.detail) {
      const detail = document.createElement("p");
      detail.textContent = event.detail;
      copy.append(detail);
    }
    if (event.details) item.title = safeJson(event.details);
    item.append(time, source, copy);
    elements.activityLog.append(item);
  }
}

function setActivityDocked(docked) {
  const wasDocked = elements.activityCenter.classList.contains("activity-docked");
  if (docked === wasDocked) {
    if (docked) updateActivityDockGeometry();
    return;
  }
  if (docked) {
    elements.activityCenter.style.setProperty(
      "--activity-status-height",
      `${elements.activityStatus.offsetHeight}px`,
    );
  }
  elements.activityCenter.classList.toggle("activity-docked", docked);
  updateActivityDockGeometry();
}

function updateActivityDock() {
  setActivityDocked(elements.activityAnchor.getBoundingClientRect().bottom <= 0);
}

function updateActivityDockGeometry() {
  if (!elements.activityCenter.classList.contains("activity-docked")) return;
  const bounds = elements.activityCenter.getBoundingClientRect();
  elements.activityStatus.style.setProperty("--activity-dock-left", `${bounds.left}px`);
  elements.activityStatus.style.setProperty("--activity-dock-width", `${bounds.width}px`);
}

async function copyActivityLog() {
  const diagnostics = state.activityEvents.map((event) => {
    const detail = event.detail ? ` — ${event.detail}` : "";
    const technical = event.details ? `\n  ${safeJson(event.details)}` : "";
    return `${event.at} [${event.source}] ${event.title}${detail}${technical}`;
  }).join("\n");
  await copyText(diagnostics || "Folio is ready for its first activity.");
  elements.copyActivityLog.textContent = "Diagnostics copied";
  window.setTimeout(() => { elements.copyActivityLog.textContent = "Copy diagnostics"; }, 1_600);
}

function setServiceState(card, label, status = "idle", copy = "") {
  card.classList.remove("loading", "active", "ready", "error");
  if (status !== "idle") card.classList.add(status);
  label.textContent = copy || (status === "loading" ? "Working" : status === "ready" ? "Ready" : status === "error" ? "Review" : "On demand");
}

function clearReport() {
  state.report = null;
  state.reportDocumentLabel = "";
  state.reportSql = "";
  state.reportQuestion = "";
  syncQueryAndReportControls();
}

function downloadCsvReport() {
  if (!state.report) return;
  downloadReportCsv(state.report, state.reportDocumentLabel || state.documentLabel);
  appendActivity({
    source: "Report",
    title: "CSV downloaded",
    detail: `${state.report.rows.length} ${state.report.rows.length === 1 ? "row" : "rows"} saved from this report.`,
    status: "ready",
  });
  elements.downloadCsv.textContent = "CSV downloaded";
  window.setTimeout(() => { elements.downloadCsv.innerHTML = '<span aria-hidden="true">↓</span> Download CSV'; }, 1_600);
}

function downloadReportCsv(report, documentLabel) {
  const csv = createCsv(report.columns, report.rows);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = createReportFilename(documentLabel);
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function safeJson(value) {
  try {
    return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
  } catch {
    return String(value);
  }
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
