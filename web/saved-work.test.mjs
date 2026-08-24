import assert from "node:assert/strict";
import test from "node:test";

import {
  SAVED_WORK_KEY,
  deleteSavedWork,
  readSavedWork,
  saveSavedWork,
} from "./saved-work.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test("saved queries preserve exact SQL and document context", () => {
  const storage = memoryStorage();
  const { item } = saveSavedWork(storage, {
    kind: "query",
    title: "  Active artists  ",
    documentLabel: "catalog.json",
    question: "Which artists are active?",
    sql: "SELECT *\nFROM nodes;",
  }, { id: "query-1", now: new Date("2026-08-23T10:00:00Z") });

  assert.equal(item.title, "Active artists");
  assert.equal(item.sql, "SELECT *\nFROM nodes;");
  assert.equal(readSavedWork(storage)[0].documentLabel, "catalog.json");
});

test("saved reports retain columns, rows, and the query that produced them", () => {
  const storage = memoryStorage();
  saveSavedWork(storage, {
    kind: "report",
    title: "Release totals",
    documentLabel: "releases.xml",
    sql: "SELECT artist, count(*) FROM nodes GROUP BY artist;",
    report: {
      columns: ["artist", "count"],
      rows: [["Aster", 3], ["Björk", 2]],
    },
  }, { id: "report-1", now: new Date("2026-08-23T11:00:00Z") });

  assert.deepEqual(readSavedWork(storage)[0].report, {
    columns: ["artist", "count"],
    rows: [["Aster", 3], ["Björk", 2]],
  });
});

test("editing keeps the id and creation date while moving the item to the top", () => {
  const storage = memoryStorage();
  saveSavedWork(storage, {
    kind: "query", title: "First", sql: "SELECT 1;",
  }, { id: "query-1", now: new Date("2026-08-23T10:00:00Z") });
  saveSavedWork(storage, {
    id: "query-1", kind: "query", title: "Renamed", sql: "SELECT 2;",
  }, { now: new Date("2026-08-23T12:00:00Z") });

  const [item] = readSavedWork(storage);
  assert.equal(item.id, "query-1");
  assert.equal(item.title, "Renamed");
  assert.equal(item.createdAt, "2026-08-23T10:00:00.000Z");
  assert.equal(item.updatedAt, "2026-08-23T12:00:00.000Z");
});

test("malformed entries are ignored and items can be deleted", () => {
  const storage = memoryStorage({ [SAVED_WORK_KEY]: "not-json" });
  assert.deepEqual(readSavedWork(storage), []);
  saveSavedWork(storage, { kind: "query", title: "Keep", sql: "SELECT 1;" }, { id: "one" });
  assert.deepEqual(deleteSavedWork(storage, "one"), []);
});

test("oversized reports fail before local storage is changed", () => {
  const storage = memoryStorage();
  assert.throws(() => saveSavedWork(storage, {
    kind: "report",
    title: "Too large",
    report: { columns: ["value"], rows: [["x".repeat(1_300_000)]] },
  }), /too large/i);
  assert.equal(storage.getItem(SAVED_WORK_KEY), null);
});
