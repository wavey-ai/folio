const NUMERIC_TYPE_IDS = new Set([20, 21, 23, 26, 28, 29, 700, 701, 790, 1700]);

export class PgrustClient {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.worker = null;
    this.ready = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  boot() {
    if (this.ready) return this.ready;
    const workerUrl = new URL("./vendor/pgrust/worker.js?v=20260823-10", import.meta.url);
    this.worker = new Worker(workerUrl, { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.worker.addEventListener("message", ({ data }) => {
        if (data.type === "status" || data.type === "build") {
          this.onEvent(data);
          return;
        }
        if (data.type === "ready") {
          this.onEvent(data);
          resolve(data);
          return;
        }
        const request = this.pending.get(data.id);
        if (!request) {
          if (data.type === "error") reject(new Error(data.message));
          return;
        }
        this.pending.delete(data.id);
        clearTimeout(request.timer);
        if (data.type === "error") request.reject(new Error(data.message));
        else request.resolve(data);
      });
      this.worker.addEventListener("error", (event) => reject(new Error(event.message)));
    });
    return this.ready;
  }

  async reset() {
    await this.boot();
    await this.request("reset");
  }

  async exec(sql) {
    await this.boot();
    return resultFromWorker(await this.request("run", { sql }));
  }

  request(type, payload = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`PostgreSQL ${type} took longer than five minutes.`));
      }, 300_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type, id, ...payload });
    });
  }
}

export function resultFromWorker(message) {
  if (message.engine === "wire" && message.wire) {
    const result = message.wire;
    if (result.error) {
      return {
        kind: "error",
        error: result.error,
        text: result.error.message,
        durationMs: message.ms,
      };
    }
    if (result.columns?.length) {
      return {
        kind: "table",
        columns: result.columns.map((column) => column.name),
        rows: result.rows.map((row) => row.map((value) => value ?? "")),
        aligns: result.columns.map((column) => NUMERIC_TYPE_IDS.has(column.typeid) ? "right" : "left"),
        durationMs: message.ms,
      };
    }
    return { kind: "command", text: result.tag || "Ready", durationMs: message.ms };
  }

  const diagnostic = firstDiagnostic(message.stderr);
  if (diagnostic) {
    return { kind: "error", error: diagnostic, text: diagnostic.message, durationMs: message.ms };
  }
  const table = parseSingleUserTable(message.stdout);
  if (table) return { kind: "table", ...table, durationMs: message.ms };
  return { kind: "command", text: message.formatted || "Ready", durationMs: message.ms };
}

function firstDiagnostic(stderr = "") {
  for (const rawLine of stderr.split("\n")) {
    const line = rawLine.replace(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? \S+ \[\d+\] /,
      "",
    );
    const match = /^(ERROR|FATAL|PANIC):\s*(.*)$/.exec(line.trim());
    if (match) return { severity: match[1], message: match[2] };
  }
  return null;
}

function parseSingleUserTable(raw = "") {
  const text = raw.replace(/^(?:backend>\s?)+/gm, "");
  const marks = [...text.matchAll(/^\t *(?:\d+:|----)/gm)].map((match) => match.index);
  const records = marks.map((start, index) => text.slice(start, marks[index + 1] ?? text.length));
  const columns = [];
  const rows = [];
  let row = null;
  let bodyStarted = false;

  for (const record of records) {
    const body = record.replace(/^\t/, "");
    if (body.startsWith("----")) {
      if (row) rows.push(row);
      row = null;
      bodyStarted = true;
      continue;
    }
    const field = /^\s*(\d+):\s?([\s\S]*)$/.exec(body);
    if (!field) continue;
    const index = Number(field[1]) - 1;
    const descriptor = field[2].lastIndexOf("\t(");
    const value = descriptor >= 0 ? field[2].slice(0, descriptor) : field[2];
    if (!bodyStarted) {
      columns[index] = value.trim();
      continue;
    }
    if (!row) row = new Array(columns.length).fill("");
    row[index] = /=\s*"([\s\S]*)"\s*$/.exec(value)?.[1] || "";
  }
  if (row) rows.push(row);
  return columns.length ? { columns, rows, aligns: columns.map(() => "left") } : null;
}
