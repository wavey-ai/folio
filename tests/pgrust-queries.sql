WITH RECURSIVE tree(id, parent_id, table_name, depth) AS (
    SELECT id, parent_id, value, 0
    FROM nodes
    WHERE name = '_tree' AND parent_id IS NULL AND value = 'report'
    UNION ALL
    SELECT child.id, child.parent_id, child.value, tree.depth + 1
    FROM tree
    JOIN nodes AS child
      ON child.parent_id = tree.id
     AND child.name = '_tree'
)
SELECT CASE
    WHEN count(*) = 3 AND max(depth) = 1 THEN 'JSON2LEAF_TREE_OK'
    ELSE 'JSON2LEAF_TREE_FAIL'
END AS verdict
FROM tree;

WITH item_rows AS (
    SELECT
        id,
        max(value) FILTER (WHERE path = 'name') AS item_name,
        max(value::numeric) FILTER (WHERE path = 'amount') AS amount
    FROM nodes
    WHERE name = 'report__items'
    GROUP BY id
)
SELECT CASE
    WHEN count(*) = 2
     AND sum(amount) = 205.5
     AND string_agg(item_name, ',' ORDER BY item_name) = 'Costs,Revenue'
    THEN 'JSON2LEAF_ROWS_OK'
    ELSE 'JSON2LEAF_ROWS_FAIL'
END AS verdict
FROM item_rows;

SELECT CASE
    WHEN count(*) = 1 AND max(value) = 'Quarterly report'
    THEN 'JSON2LEAF_ROOT_OK'
    ELSE 'JSON2LEAF_ROOT_FAIL'
END AS verdict
FROM nodes
WHERE name = 'report' AND path = 'title';

WITH pathway AS (
    SELECT
        id,
        max(value) FILTER (WHERE path = '@rdf:id') AS pathway_id,
        max(value) FILTER (WHERE path = 'bp:display_name__$text') AS pathway_name
    FROM nodes
    WHERE name = 'reactome_pathways__bp:pathway'
    GROUP BY id
),
component_reference AS (
    SELECT
        id,
        parent_id,
        max(value) FILTER (WHERE path = '@rdf:resource') AS resource_id
    FROM nodes
    WHERE name = 'reactome_pathways__bp:pathway__bp:pathway_component'
    GROUP BY id, parent_id
),
component AS (
    SELECT
        parent.pathway_name AS pathway,
        child.pathway_name AS component
    FROM pathway AS parent
    JOIN component_reference AS reference
      ON reference.parent_id = parent.id
    JOIN pathway AS child
      ON child.pathway_id = ltrim(reference.resource_id, '#')
    WHERE parent.pathway_name = 'Programmed Cell Death'
)
SELECT CASE
    WHEN count(*) = 2
     AND string_agg(component, ',' ORDER BY component) = 'Apoptosis,Regulated Necrosis'
    THEN 'JSON2LEAF_RELATIONSHIP_OK'
    ELSE 'JSON2LEAF_RELATIONSHIP_FAIL'
END AS verdict
FROM component;
