export const SAVED_WORK_KEY = "folio.saved-work.v1";
export const SAVED_WORK_LIMIT = 40;

const MAX_ITEM_CHARACTERS = 1_250_000;
const MAX_LIBRARY_CHARACTERS = 2_250_000;

export function readSavedWork(storage = globalThis.localStorage) {
  if (!storage) return [];
  let parsed;
  try {
    parsed = JSON.parse(storage.getItem(SAVED_WORK_KEY) || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(normalizeStoredItem)
    .filter(Boolean)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, SAVED_WORK_LIMIT);
}

export function saveSavedWork(storage, draft, options = {}) {
  if (!storage) throw new Error("This browser cannot save work locally.");
  const now = options.now instanceof Date ? options.now : new Date();
  const existing = readSavedWork(storage);
  const previous = draft.id ? existing.find((item) => item.id === draft.id) : null;
  const item = normalizeDraft({
    ...draft,
    id: previous?.id || draft.id || options.id || createSavedWorkId(),
    createdAt: previous?.createdAt || draft.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const serializedItem = JSON.stringify(item);
  if (serializedItem.length > MAX_ITEM_CHARACTERS) {
    throw new Error("This report is too large for browser storage. Download its CSV instead.");
  }

  const next = [item, ...existing.filter((entry) => entry.id !== item.id)]
    .slice(0, SAVED_WORK_LIMIT);
  const payload = JSON.stringify(next);
  if (payload.length > MAX_LIBRARY_CHARACTERS) {
    throw new Error("Saved work is full. Delete an older item, then try again.");
  }
  try {
    storage.setItem(SAVED_WORK_KEY, payload);
  } catch {
    throw new Error("Saved work is full. Delete an older item, then try again.");
  }
  return { item, items: next };
}

export function deleteSavedWork(storage, id) {
  if (!storage) return [];
  const next = readSavedWork(storage).filter((item) => item.id !== id);
  storage.setItem(SAVED_WORK_KEY, JSON.stringify(next));
  return next;
}

export function createSavedWorkId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `saved-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeDraft(draft) {
  const kind = draft.kind === "report" ? "report" : draft.kind === "query" ? "query" : "";
  if (!kind) throw new Error("Choose a query or report to save.");
  const title = cleanText(draft.title, 80);
  if (!title) throw new Error("Give this saved item a name.");
  const sql = String(draft.sql || "").trim();
  if (kind === "query" && !sql) throw new Error("Write a query before saving it.");
  const report = kind === "report" ? normalizeReport(draft.report) : null;
  if (kind === "report" && !report) throw new Error("Run a report before saving it.");
  return {
    version: 1,
    id: cleanText(draft.id, 120),
    kind,
    title,
    documentLabel: cleanText(draft.documentLabel || "document", 160),
    question: cleanText(draft.question, 600),
    sql,
    report,
    createdAt: normalizeDate(draft.createdAt),
    updatedAt: normalizeDate(draft.updatedAt),
  };
}

function normalizeStoredItem(item) {
  try {
    if (!item || item.version !== 1 || !item.id) return null;
    return normalizeDraft(item);
  } catch {
    return null;
  }
}

function normalizeReport(report) {
  if (!report || !Array.isArray(report.columns) || !Array.isArray(report.rows)) return null;
  const columns = report.columns.map((column) => cleanText(column, 300));
  const rows = report.rows.map((row) => {
    if (!Array.isArray(row)) return columns.map(() => null);
    return columns.map((_, index) => normalizeCell(row[index]));
  });
  return { columns, rows };
}

function normalizeCell(value) {
  if (value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function cleanText(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function normalizeDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}
