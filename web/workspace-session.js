const DATABASE_NAME = "folio-workspace";
const DATABASE_VERSION = 1;
const STORE_NAME = "documents";
const CURRENT_DOCUMENT = "current";

export async function saveWorkspaceDocument({ source, format, label, blob }) {
  if (!globalThis.indexedDB || !(blob instanceof Blob)) return false;
  const database = await openDatabase();
  try {
    await runTransaction(database, "readwrite", (store) => store.put({
      id: CURRENT_DOCUMENT,
      source,
      format,
      label,
      blob,
      savedAt: new Date().toISOString(),
    }));
    return true;
  } finally {
    database.close();
  }
}

export async function readWorkspaceDocument() {
  if (!globalThis.indexedDB) return null;
  const database = await openDatabase();
  try {
    const record = await runTransaction(
      database,
      "readonly",
      (store) => store.get(CURRENT_DOCUMENT),
    );
    if (!record?.blob) return null;
    return {
      source: record.source || "document",
      format: ["xml", "csv"].includes(record.format) ? record.format : "json",
      label: record.label || record.source || "document",
      blob: record.blob,
      savedAt: record.savedAt || "",
    };
  } finally {
    database.close();
  }
}

export async function clearWorkspaceDocument() {
  if (!globalThis.indexedDB) return;
  const database = await openDatabase();
  try {
    await runTransaction(database, "readwrite", (store) => store.delete(CURRENT_DOCUMENT));
  } finally {
    database.close();
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => reject(new Error("The local workspace store is busy.")), {
      once: true,
    });
  });
}

function runTransaction(database, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    let result;
    request.addEventListener("success", () => { result = request.result; }, { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    transaction.addEventListener("complete", () => resolve(result), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error), { once: true });
  });
}
