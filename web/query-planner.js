const identifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

const discogsReleaseTable = "discogs_releases__release";
const discogsArtistTable = `${discogsReleaseTable}__artists__artist`;
const discogsLabelTable = `${discogsReleaseTable}__labels__label`;
const discogsGenreTable = `${discogsReleaseTable}__genres__genre`;
const discogsStyleTable = `${discogsReleaseTable}__styles__style`;
const discogsTrackTable = `${discogsReleaseTable}__tracklist__track`;

export function buildCatalog(leaves) {
  const tables = new Map();
  for (const leaf of leaves) {
    if (leaf.name === "_tree") continue;
    if (!tables.has(leaf.name)) {
      tables.set(leaf.name, { name: leaf.name, fields: new Map(), rows: new Set() });
    }
    const table = tables.get(leaf.name);
    table.rows.add(leaf.id);
    if (!table.fields.has(leaf.path)) {
      table.fields.set(leaf.path, { name: leaf.path, type: leaf.data_type });
    }
  }
  return [...tables.values()]
    .map((table) => ({
      name: table.name,
      rowCount: table.rows.size,
      fields: [...table.fields.values()].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildSql(plan, catalog) {
  if (plan.operation === "tree") return treeSql();
  if (plan.operation === "discogs-artist-overview") return discogsArtistOverviewSql();
  const table = catalog.find((item) => item.name === plan.table);
  if (!table) return "SELECT 'Choose a table' AS next_step;";

  const selected = plan.fields.length ? plan.fields : table.fields.map((field) => field.name);
  const fields = table.fields.filter((field) => selected.includes(field.name));
  const records = recordCte(table, fields);
  const where = filterSql(plan.filter, table);

  if (plan.operation === "count") {
    return `${records}\nSELECT count(*) AS row_count\nFROM records${where};`;
  }

  if (plan.operation === "sum" || plan.operation === "average") {
    const numeric = fields.find((field) => field.type === "number")
      || table.fields.find((field) => field.type === "number");
    if (!numeric) return `${records}\nSELECT count(*) AS row_count\nFROM records${where};`;
    const functionName = plan.operation === "sum" ? "sum" : "avg";
    const alias = plan.operation === "sum" ? "total" : "average";
    return `${records}\nSELECT ${functionName}(${identifier(numeric.name)}) AS ${alias}\nFROM records${where};`;
  }

  const columns = fields.length
    ? fields.map((field) => identifier(field.name)).join(",\n    ")
    : "*";
  return `${records}\nSELECT\n    ${columns}\nFROM records${where}\nORDER BY id\nLIMIT 100;`;
}

export function preview(plan, leaves, catalog) {
  if (plan.operation === "tree") return previewTree(leaves);
  if (plan.operation === "discogs-artist-overview") return previewDiscogsArtistOverview(leaves);
  const table = catalog.find((item) => item.name === plan.table);
  if (!table) return { columns: [], rows: [] };
  const selected = plan.fields.length ? plan.fields : table.fields.map((field) => field.name);
  const records = new Map();

  for (const leaf of leaves) {
    if (leaf.name !== table.name) continue;
    if (!records.has(leaf.id)) records.set(leaf.id, { id: leaf.id, parent_id: leaf.parent_id });
    records.get(leaf.id)[leaf.path] = leaf.value;
  }

  let rows = [...records.values()];
  rows = rows.filter((row) => matchesFilter(row, plan.filter, table));

  if (plan.operation === "count") {
    return { columns: ["row_count"], rows: [{ row_count: rows.length }] };
  }

  if (plan.operation === "sum" || plan.operation === "average") {
    const numeric = table.fields.find(
      (field) => field.type === "number" && selected.includes(field.name),
    ) || table.fields.find((field) => field.type === "number");
    const values = numeric ? rows.map((row) => Number(row[numeric.name])).filter(Number.isFinite) : [];
    const total = values.reduce((sum, value) => sum + value, 0);
    const key = plan.operation === "sum" ? "total" : "average";
    const value = plan.operation === "sum" ? total : values.length ? total / values.length : null;
    return { columns: [key], rows: [{ [key]: value }] };
  }

  return {
    columns: selected,
    rows: rows
      .slice(0, 100)
      .map((row) => Object.fromEntries(selected.map((field) => [field, row[field]]))),
  };
}

function recordCte(table, fields) {
  const projections = fields.map((field) => {
    const value = field.type === "number" ? "value::numeric" : "value";
    return `        max(${value}) FILTER (WHERE path = ${literal(field.name)}) AS ${identifier(field.name)}`;
  });
  const separator = projections.length ? ",\n" : "\n";
  return `WITH RECURSIVE records AS (\n    SELECT\n        id,\n        parent_id${separator}${projections.join(",\n")}\n    FROM nodes\n    WHERE name = ${literal(table.name)}\n    GROUP BY id, parent_id\n)`;
}

function filterSql(filter, table) {
  if (!filter?.field || filter.value === "") return "";
  const field = table.fields.find((item) => item.name === filter.field);
  if (!field) return "";
  const column = identifier(field.name);
  const value = field.type === "number" ? Number(filter.value) : filter.value;
  const safeValue = field.type === "number" && Number.isFinite(value) ? String(value) : literal(value);
  const expression = {
    equals: `${column} = ${safeValue}`,
    contains: `${column}::text ILIKE ${literal(`%${filter.value}%`)}`,
    greater: `${column} > ${safeValue}`,
    less: `${column} < ${safeValue}`,
  }[filter.operator];
  return expression ? `\nWHERE ${expression}` : "";
}

function treeSql() {
  return `WITH RECURSIVE tree AS (
    SELECT id, parent_id, value AS table_name, 0 AS depth
    FROM nodes
    WHERE name = '_tree' AND parent_id IS NULL
    UNION ALL
    SELECT child.id, child.parent_id, child.value, tree.depth + 1
    FROM tree
    JOIN nodes AS child
      ON child.parent_id = tree.id
     AND child.name = '_tree'
)
SELECT id, parent_id, table_name, depth
FROM tree
ORDER BY depth, table_name;`;
}

function discogsArtistOverviewSql() {
  return `WITH RECURSIVE release AS (
    SELECT
        id,
        max(value) FILTER (WHERE path = 'artists__artist__name') AS artist_name,
        max(value) FILTER (WHERE path = 'labels__label__@name') AS label_name,
        max(value) FILTER (WHERE path = 'genres__genre') AS genre,
        max(value) FILTER (WHERE path = 'styles__style') AS style,
        max(value) FILTER (WHERE path = 'tracklist__track__title') AS single_track_title
    FROM nodes
    WHERE name = '${discogsReleaseTable}'
    GROUP BY id
),
release_tree AS (
    SELECT id AS release_row_id, id
    FROM release
    UNION ALL
    SELECT release_tree.release_row_id, child.id
    FROM release_tree
    JOIN nodes AS child
      ON child.parent_id = release_tree.id
     AND child.name = '_tree'
),
release_nodes AS (
    SELECT release_tree.release_row_id, nodes.id, nodes.name, nodes.path, nodes.value
    FROM release_tree
    JOIN nodes ON nodes.id = release_tree.id
    WHERE nodes.name IN (
        '${discogsArtistTable}', '${discogsLabelTable}',
        '${discogsGenreTable}', '${discogsStyleTable}', '${discogsTrackTable}'
    )
),
release_artist AS (
    SELECT id AS release_row_id, artist_name AS artist
    FROM release
    WHERE artist_name IS NOT NULL
    UNION ALL
    SELECT release_row_id, max(value) FILTER (WHERE path = 'name')
    FROM release_nodes
    WHERE name = '${discogsArtistTable}'
    GROUP BY release_row_id, id
),
release_label AS (
    SELECT id AS release_row_id, label_name AS label
    FROM release
    WHERE label_name IS NOT NULL
    UNION ALL
    SELECT release_row_id, max(value) FILTER (WHERE path = '@name')
    FROM release_nodes
    WHERE name = '${discogsLabelTable}'
    GROUP BY release_row_id, id
),
release_genre AS (
    SELECT id AS release_row_id, genre
    FROM release
    WHERE genre IS NOT NULL
    UNION ALL
    SELECT release_row_id, max(value) FILTER (WHERE path = 'value')
    FROM release_nodes
    WHERE name = '${discogsGenreTable}'
    GROUP BY release_row_id, id
),
release_style AS (
    SELECT id AS release_row_id, style
    FROM release
    WHERE style IS NOT NULL
    UNION ALL
    SELECT release_row_id, max(value) FILTER (WHERE path = 'value')
    FROM release_nodes
    WHERE name = '${discogsStyleTable}'
    GROUP BY release_row_id, id
),
track_rows AS (
    SELECT id AS release_row_id, 1::bigint AS tracks
    FROM release
    WHERE single_track_title IS NOT NULL
    UNION ALL
    SELECT release_row_id, count(DISTINCT id)::bigint
    FROM release_nodes
    WHERE name = '${discogsTrackTable}' AND path = 'title'
    GROUP BY release_row_id
),
track_count AS (
    SELECT release_row_id, sum(tracks)::bigint AS tracks
    FROM track_rows
    GROUP BY release_row_id
),
electronic_release AS (
    SELECT DISTINCT
        release.id AS release_row_id,
        artist.artist
    FROM release
    JOIN release_artist AS artist
      ON artist.release_row_id = release.id
    WHERE EXISTS (
        SELECT 1
        FROM release_genre AS genre
        WHERE genre.release_row_id = release.id
          AND genre.genre = 'Electronic'
    )
),
artist_totals AS (
    SELECT
        electronic_release.artist,
        count(DISTINCT electronic_release.release_row_id)::bigint AS release_count,
        coalesce(sum(track_count.tracks), 0)::bigint AS track_count
    FROM electronic_release
    LEFT JOIN track_count
      ON track_count.release_row_id = electronic_release.release_row_id
    GROUP BY electronic_release.artist
    HAVING count(DISTINCT electronic_release.release_row_id) >= 3
),
artist_labels AS (
    SELECT
        electronic_release.artist,
        count(DISTINCT release_label.label)::bigint AS label_count,
        string_agg(DISTINCT release_label.label, ', ' ORDER BY release_label.label) AS labels
    FROM electronic_release
    JOIN release_label
      ON release_label.release_row_id = electronic_release.release_row_id
    GROUP BY electronic_release.artist
),
artist_styles AS (
    SELECT
        electronic_release.artist,
        string_agg(DISTINCT release_style.style, ', ' ORDER BY release_style.style) AS styles
    FROM electronic_release
    JOIN release_style
      ON release_style.release_row_id = electronic_release.release_row_id
    GROUP BY electronic_release.artist
)
SELECT
    artist_totals.artist,
    artist_totals.release_count,
    artist_totals.track_count,
    coalesce(artist_labels.label_count, 0) AS label_count,
    coalesce(artist_labels.labels, '') AS labels,
    coalesce(artist_styles.styles, '') AS styles
FROM artist_totals
LEFT JOIN artist_labels USING (artist)
LEFT JOIN artist_styles USING (artist)
ORDER BY release_count DESC, track_count DESC, artist
LIMIT 25;`;
}

function previewDiscogsArtistOverview(leaves) {
  const artists = new Map();
  const labels = new Map();
  const genres = new Map();
  const styles = new Map();
  const tracks = new Map();
  const parents = new Map();
  const releaseOwners = new Map();
  for (const leaf of leaves) {
    parents.set(leaf.id, leaf.parent_id);
    if (leaf.name === discogsReleaseTable) releaseOwners.set(leaf.id, leaf.id);
  }

  function releaseFor(id) {
    const visited = new Set();
    let current = id;
    while (current && !releaseOwners.has(current) && !visited.has(current)) {
      visited.add(current);
      current = parents.get(current);
    }
    const releaseId = releaseOwners.get(current);
    for (const recordId of visited) releaseOwners.set(recordId, releaseId);
    return releaseId;
  }

  for (const leaf of leaves) {
    if (leaf.name === discogsReleaseTable) {
      if (leaf.path === "artists__artist__name") addDimension(artists, leaf.id, leaf.value);
      if (leaf.path === "labels__label__@name") addDimension(labels, leaf.id, leaf.value);
      if (leaf.path === "genres__genre") addDimension(genres, leaf.id, leaf.value);
      if (leaf.path === "styles__style") addDimension(styles, leaf.id, leaf.value);
      if (leaf.path === "tracklist__track__title") addDimension(tracks, leaf.id, `${leaf.id}:single`);
      continue;
    }

    if (leaf.name === "_tree") continue;
    const releaseId = releaseFor(leaf.id);
    if (leaf.name === discogsArtistTable && leaf.path === "name") {
      addDimension(artists, releaseId, leaf.value);
    } else if (leaf.name === discogsLabelTable && leaf.path === "@name") {
      addDimension(labels, releaseId, leaf.value);
    } else if (leaf.name === discogsGenreTable && leaf.path === "value") {
      addDimension(genres, releaseId, leaf.value);
    } else if (leaf.name === discogsStyleTable && leaf.path === "value") {
      addDimension(styles, releaseId, leaf.value);
    } else if (leaf.name === discogsTrackTable && leaf.path === "title") {
      addDimension(tracks, releaseId, leaf.id);
    }
  }

  const totals = new Map();
  for (const [releaseId, releaseGenres] of genres) {
    if (!releaseGenres.has("Electronic")) continue;
    for (const artist of artists.get(releaseId) || []) {
      if (!totals.has(artist)) {
        totals.set(artist, {
          artist,
          releases: new Set(),
          track_count: 0,
          labels: new Set(),
          styles: new Set(),
        });
      }
      const total = totals.get(artist);
      if (total.releases.has(releaseId)) continue;
      total.releases.add(releaseId);
      total.track_count += tracks.get(releaseId)?.size || 0;
      for (const label of labels.get(releaseId) || []) total.labels.add(label);
      for (const style of styles.get(releaseId) || []) total.styles.add(style);
    }
  }

  const rows = [...totals.values()]
    .filter((total) => total.releases.size >= 3)
    .sort((left, right) => right.releases.size - left.releases.size
      || right.track_count - left.track_count
      || left.artist.localeCompare(right.artist))
    .slice(0, 25)
    .map((total) => ({
      artist: total.artist,
      release_count: total.releases.size,
      track_count: total.track_count,
      label_count: total.labels.size,
      labels: [...total.labels].sort().join(", "),
      styles: [...total.styles].sort().join(", "),
    }));

  return {
    columns: ["artist", "release_count", "track_count", "label_count", "labels", "styles"],
    rows,
  };
}

function addDimension(collection, id, value) {
  const normalized = String(value ?? "").trim();
  if (!id || !normalized) return;
  if (!collection.has(id)) collection.set(id, new Set());
  collection.get(id).add(normalized);
}

function previewTree(leaves) {
  const treeLeaves = [];
  const parents = new Map();
  for (const leaf of leaves) {
    if (leaf.name !== "_tree") continue;
    treeLeaves.push(leaf);
    parents.set(leaf.id, leaf.parent_id);
  }
  const nodes = treeLeaves.map((leaf) => ({
      id: leaf.id,
      parent_id: leaf.parent_id,
      table_name: leaf.value,
      depth: depthFor(leaf, parents),
    }));
  return { columns: ["table_name", "depth", "id"], rows: nodes };
}

function depthFor(leaf, parents) {
  let depth = 0;
  let parent = leaf.parent_id;
  while (parent) {
    depth += 1;
    parent = parents.get(parent);
  }
  return depth;
}

function matchesFilter(row, filter, table) {
  if (!filter?.field || filter.value === "") return true;
  const field = table.fields.find((item) => item.name === filter.field);
  const actual = row[filter.field];
  if (field?.type === "number") {
    const left = Number(actual);
    const right = Number(filter.value);
    if (filter.operator === "greater") return left > right;
    if (filter.operator === "less") return left < right;
    return left === right;
  }
  const left = String(actual ?? "").toLowerCase();
  const right = String(filter.value).toLowerCase();
  if (filter.operator === "contains") return left.includes(right);
  return left === right;
}
