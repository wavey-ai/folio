export function parseCsv(input) {
  const text = input.replace(/^\uFEFF/, "");
  const records = [];
  let headers = null;
  let row = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  let recordStarted = false;
  let rowNumber = 1;

  function finishCell() {
    row.push(cell);
    cell = "";
    closedQuote = false;
  }

  function finishRow() {
    finishCell();
    if (recordStarted) {
      if (!headers) {
        headers = row.map((name) => name.trim());
        if (headers.some((name) => !name)) {
          throw new Error("CSV column names must not be empty.");
        }
        if (new Set(headers).size !== headers.length) {
          throw new Error("CSV column names must be unique.");
        }
      } else {
        if (row.length !== headers.length) {
          throw new Error(`CSV row ${rowNumber} has ${row.length} cells; expected ${headers.length}.`);
        }
        records.push(Object.fromEntries(headers.map((name, index) => [name, row[index]])));
      }
    }
    row = [];
    recordStarted = false;
    rowNumber += 1;
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
    } else if (character === ",") {
      recordStarted = true;
      finishCell();
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else if (closedQuote) {
      throw new Error(`CSV row ${rowNumber} has unexpected text after a closing quote.`);
    } else if (character === '"') {
      if (cell.length) throw new Error(`CSV row ${rowNumber} has a quote inside an unquoted cell.`);
      recordStarted = true;
      quoted = true;
    } else {
      recordStarted = true;
      cell += character;
    }
  }

  if (quoted) throw new Error(`CSV row ${rowNumber} has an unclosed quoted cell.`);
  if (recordStarted) finishRow();
  if (!headers) throw new Error("The CSV file is empty. Add column names and at least one data row.");
  if (!records.length) throw new Error("The CSV file needs at least one data row after the column names.");
  return records;
}

export function createCsv(columns, rows) {
  const lines = [columns, ...rows].map((row) => row.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function createReportFilename(label, now = new Date()) {
  const source = String(label || "document")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60) || "document";
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  return `folio-${source}-report-${date}.csv`;
}

function csvCell(value) {
  let text;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  return `"${text.replaceAll('"', '""')}"`;
}
