import test from "node:test";
import assert from "node:assert/strict";

import { parseCsv, createCsv, createReportFilename } from "./csv.js";

test("CSV imports become flat objects with text values and literal column names", () => {
  assert.deepEqual(
    parseCsv(' name ,account.id,amount,active,empty\nBjörk,00123,12.50,true,\n東京,9007199254740993,0,false,'),
    [
      { name: "Björk", "account.id": "00123", amount: "12.50", active: "true", empty: "" },
      { name: "東京", "account.id": "9007199254740993", amount: "0", active: "false", empty: "" },
    ],
  );
});

test("CSV imports round-trip report quoting, BOM, newlines, and empty cells", () => {
  const columns = ["name", 'a "quoted", heading', "empty"];
  const rows = [["Jam, Cafe", 'Said "hello"\r\nagain\nand again', ""], [" Leaf Shop ", "", ""]];
  assert.deepEqual(
    parseCsv(createCsv(columns, rows)),
    rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
  );
});

test("CSV imports accept CRLF, LF, and CR records and ignore empty lines", () => {
  for (const newline of ["\r\n", "\n", "\r"]) {
    assert.deepEqual(parseCsv(["", "name,note", "", "one,", "two,end", "", ""].join(newline)), [
      { name: "one", note: "" },
      { name: "two", note: "end" },
    ]);
  }
  assert.deepEqual(parseCsv('name\n""\n\n" "\n'), [{ name: "" }, { name: " " }]);
  assert.deepEqual(parseCsv("a,b\n,\n"), [{ a: "", b: "" }]);
});

test("CSV imports preserve special object keys as own data properties", () => {
  const [row] = parseCsv("__proto__,constructor,toString\nsource,original,value");
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.equal(Object.hasOwn(row, "__proto__"), true);
  assert.equal(row.__proto__, "source");
  assert.equal(row.constructor, "original");
  assert.equal(row.toString, "value");
  assert.equal(JSON.parse(JSON.stringify(row)).__proto__, "source");
});

test("CSV imports report invalid headers, row widths, and quoting", () => {
  for (const [input, message] of [
    ["\uFEFF\r\n", /CSV file is empty/],
    ["name,note\n", /at least one data row/],
    ["name, \na,b", /column names must not be empty/],
    ["name, name\na,b", /column names must be unique/],
    ["name,note\none", /row 2 has 1 cells; expected 2/],
    ["name,note\none,two,three", /row 2 has 3 cells; expected 2/],
    ['name\n"unfinished', /row 2 has an unclosed quoted cell/],
    ['name\nun"quoted', /row 2 has a quote inside an unquoted cell/],
    ['name\n"closed"extra', /row 2 has unexpected text after a closing quote/],
  ]) {
    assert.throws(() => parseCsv(input), message);
  }
});

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
