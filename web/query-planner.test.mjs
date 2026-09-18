import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalog, buildSql, preview } from "./query-planner.js";
import { expectedArtistOverview, recursiveQueryLeaves } from "../tests/query-fixtures.mjs";

const leaves = [
  { id: "root", parent_id: null, name: "_tree", path: "", value: "report", data_type: "tree" },
  { id: "one", parent_id: "root", name: "report__rows", path: "name", value: "Revenue", data_type: "string" },
  { id: "one", parent_id: "root", name: "report__rows", path: "amount", value: "125.5", data_type: "number" },
  { id: "two", parent_id: "root", name: "report__rows", path: "name", value: "Costs", data_type: "string" },
  { id: "two", parent_id: "root", name: "report__rows", path: "amount", value: "80", data_type: "number" },
];

test("catalog groups fields and records", () => {
  const [table] = buildCatalog(leaves);
  assert.equal(table.name, "report__rows");
  assert.equal(table.rowCount, 2);
  assert.deepEqual(table.fields.map((field) => field.name), ["amount", "name"]);
});

test("query plan creates typed aggregate SQL", () => {
  const catalog = buildCatalog(leaves);
  const sql = buildSql({
    table: "report__rows",
    operation: "sum",
    fields: ["amount"],
    filter: { field: "amount", operator: "greater", value: "100" },
  }, catalog);

  assert.match(sql, /max\(value::numeric\)/);
  assert.match(sql, /^WITH RECURSIVE records AS/);
  assert.match(sql, /sum\("amount"\) AS total/);
  assert.match(sql, /WHERE "amount" > 100/);
});

test("local preview follows the query plan", () => {
  const catalog = buildCatalog(leaves);
  const result = preview({
    table: "report__rows",
    operation: "rows",
    fields: ["name", "amount"],
    filter: { field: "amount", operator: "greater", value: "100" },
  }, leaves, catalog);

  assert.deepEqual(result.columns, ["name", "amount"]);
  assert.deepEqual(result.rows, [{ name: "Revenue", amount: "125.5" }]);
});

test("text search works with each inferred field type", () => {
  const catalog = buildCatalog(leaves);
  const sql = buildSql({
    table: "report__rows",
    operation: "count",
    fields: ["amount"],
    filter: { field: "amount", operator: "contains", value: "25" },
  }, catalog);

  assert.match(sql, /"amount"::text ILIKE '%25%'/);
});

test("Discogs report recursively follows nested music records through parent ids", () => {
  const sql = buildSql({ operation: "discogs-artist-overview" }, []);

  assert.match(sql, /^WITH RECURSIVE/);
  assert.match(sql, /FROM release_tree\n    JOIN nodes AS child/);
  assert.match(sql, /child\.name = '_tree'/);
  assert.match(sql, /SELECT release_row_id, max\(value\) FILTER \(WHERE path = 'name'\)/);
  assert.match(sql, /genre\.genre = 'Electronic'/);
  assert.match(sql, /string_agg\(DISTINCT release_label\.label/);
  assert.match(sql, /count\(DISTINCT electronic_release\.release_row_id\)/);
});

test("Discogs preview follows multiple levels without multiplying scalar rows", () => {
  const fixture = recursiveQueryLeaves();
  const result = preview({ operation: "discogs-artist-overview" }, fixture, buildCatalog(fixture));
  assert.deepEqual(result.rows, expectedArtistOverview);
});

test("Discogs preview combines releases, artists, labels, styles, and tracks", () => {
  const relationshipLeaves = [
    {
      id: "release-1",
      parent_id: "root",
      name: "discogs_releases__release",
      path: "artists__artist__name",
      value: "Wavey Artist",
      data_type: "string",
    },
    {
      id: "release-1",
      parent_id: "root",
      name: "discogs_releases__release",
      path: "genres__genre",
      value: "Electronic",
      data_type: "string",
    },
    {
      id: "release-1",
      parent_id: "root",
      name: "discogs_releases__release",
      path: "labels__label__@name",
      value: "Wavey Records",
      data_type: "string",
    },
    {
      id: "release-1",
      parent_id: "root",
      name: "discogs_releases__release",
      path: "styles__style",
      value: "Deep House",
      data_type: "string",
    },
    {
      id: "release-1",
      parent_id: "root",
      name: "discogs_releases__release",
      path: "tracklist__track__title",
      value: "First Track",
      data_type: "string",
    },
    musicLeaf("release-2", "root", "", "title", "Second release"),
    musicLeaf("artist-2", "release-2", "artists__artist", "name", "Wavey Artist"),
    musicLeaf("genre-2", "release-2", "genres__genre", "value", "Electronic"),
    musicLeaf("label-2", "release-2", "labels__label", "@name", "Moon Records"),
    musicLeaf("style-2a", "release-2", "styles__style", "value", "Techno"),
    musicLeaf("style-2b", "release-2", "styles__style", "value", "Ambient"),
    musicLeaf("track-2a", "release-2", "tracklist__track", "title", "Second Track"),
    musicLeaf("track-2b", "release-2", "tracklist__track", "title", "Third Track"),
    musicLeaf("release-3", "root", "", "artists__artist__name", "Wavey Artist"),
    musicLeaf("release-3", "root", "", "genres__genre", "Electronic"),
    musicLeaf("release-3", "root", "", "labels__label__@name", "Wavey Records"),
    musicLeaf("release-3", "root", "", "styles__style", "Ambient"),
    musicLeaf("release-3", "root", "", "tracklist__track__title", "Fourth Track"),
  ];

  const result = preview(
    { operation: "discogs-artist-overview" },
    relationshipLeaves,
    buildCatalog(relationshipLeaves),
  );

  assert.deepEqual(result.columns, [
    "artist",
    "release_count",
    "track_count",
    "label_count",
    "labels",
    "styles",
  ]);
  assert.deepEqual(result.rows, [{
    artist: "Wavey Artist",
    release_count: 3,
    track_count: 4,
    label_count: 2,
    labels: "Moon Records, Wavey Records",
    styles: "Ambient, Deep House, Techno",
  }]);
});

function musicLeaf(id, parentId, suffix, path, value) {
  return {
    id,
    parent_id: parentId,
    name: suffix ? `discogs_releases__release__${suffix}` : "discogs_releases__release",
    path,
    value,
    data_type: "string",
  };
}
