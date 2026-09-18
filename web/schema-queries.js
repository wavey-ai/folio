export const SCHEMA_STARTER_QUERIES = {
  rows: `SELECT *
FROM nodes
LIMIT 10;`,
  records: `SELECT name,
       count(DISTINCT id) AS records,
       count(*) AS values
FROM nodes
WHERE name <> '_tree'
GROUP BY name
ORDER BY records DESC, values DESC
LIMIT 100;`,
  fields: `SELECT name,
       path,
       data_type,
       count(*) AS values
FROM nodes
WHERE name <> '_tree'
GROUP BY name, path, data_type
ORDER BY name, path
LIMIT 100;`,
  relationships: `WITH RECURSIVE records AS (
  SELECT DISTINCT id, parent_id, value AS name
  FROM nodes
  WHERE name = '_tree'
), ancestry AS (
  SELECT id AS ancestor_id, name AS ancestor_type,
         id AS descendant_id, 0 AS depth
  FROM records
  UNION ALL
  SELECT ancestry.ancestor_id, ancestry.ancestor_type,
         child.id, ancestry.depth + 1
  FROM ancestry
  JOIN records AS child ON child.parent_id = ancestry.descendant_id
)
SELECT ancestry.ancestor_type,
       child.name AS descendant_type,
       ancestry.depth,
       count(*) AS links
FROM ancestry
JOIN records AS child ON child.id = ancestry.descendant_id
WHERE ancestry.depth > 0
GROUP BY ancestry.ancestor_type, child.name, ancestry.depth
ORDER BY links DESC, ancestor_type, descendant_type, depth
LIMIT 100;`,
};
