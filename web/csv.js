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
