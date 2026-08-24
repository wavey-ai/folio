import test from "node:test";
import assert from "node:assert/strict";

import { createCsv, createReportFilename } from "./csv.js";

test("CSV reports preserve commas, quotes, newlines, and empty values", () => {
  const csv = createCsv(
    ["name", "note", "value"],
    [["Jam, Cafe", 'Said "hello"\nagain', null]],
  );
  assert.equal(
    csv,
    '\uFEFF"name","note","value"\r\n"Jam, Cafe","Said ""hello""\nagain",""\r\n',
  );
});

test("report filenames use the document label and date", () => {
  assert.equal(
    createReportFilename("Discogs releases", new Date(2026, 7, 23)),
    "folio-discogs-releases-report-20260823.csv",
  );
});
