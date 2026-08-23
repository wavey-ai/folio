use json2leaf::{ColumnOverride, Config, DataType, Mapper};
use pretty_assertions::assert_eq;
use serde_json::json;

#[test]
fn maps_nested_objects_and_arrays() {
    let input = br#"
    {
        "foo": "foo_v",
        "bar": {"baz": "baz_v"},
        "items": [{"amount": 1.3}, {"amount": 2}],
        "mixed": ["a", 1, false],
        "ignored": null
    }
    "#;
    let leaves = Mapper::new(Config::default())
        .map_json("Report", input)
        .unwrap();
    let values = leaves
        .iter()
        .filter(|leaf| leaf.name != "_tree")
        .map(|leaf| {
            (
                leaf.name.as_str(),
                leaf.path.as_str(),
                leaf.data_type,
                &leaf.value,
            )
        })
        .collect::<Vec<_>>();

    assert!(values.contains(&("report", "foo", DataType::String, &json!("foo_v"))));
    assert!(values.contains(&("report", "bar__baz", DataType::String, &json!("baz_v"))));
    assert!(values.contains(&("report__items", "amount", DataType::Number, &json!(1.3))));
    assert!(values.contains(&("report__mixed", "value", DataType::Boolean, &json!(false))));
    assert_eq!(values.len(), 7);

    for leaf in leaves.iter().filter(|leaf| leaf.name != "_tree") {
        assert!(leaves.iter().any(|tree| {
            tree.name == "_tree" && tree.id == leaf.id && tree.parent_id == leaf.parent_id
        }));
    }
}

#[test]
fn selects_a_json_path() {
    let leaves = Mapper::new(Config::default())
        .map_json_path(
            "report",
            "wrapper.data",
            br#"{"wrapper":{"data":{"ok":true}}}"#,
        )
        .unwrap();

    assert!(leaves.iter().any(|leaf| leaf.path == "ok"));
}

#[test]
fn applies_a_column_override() {
    let config = Config {
        column_overrides: vec![ColumnOverride {
            table: "report".to_owned(),
            path: "person__name".to_owned(),
            target_table: "person".to_owned(),
            target_path: "name".to_owned(),
        }],
        ..Config::default()
    };
    let leaves = Mapper::new(config)
        .map_json("report", br#"{"person":{"name":"Ada"}}"#)
        .unwrap();
    let leaf = leaves.iter().find(|leaf| leaf.name != "_tree").unwrap();

    assert_eq!(leaf.name, "person");
    assert_eq!(leaf.path, "name");
    assert!(leaf.parent_id.is_some());
}

#[test]
fn creates_stable_ids() {
    let mapper = Mapper::new(Config::default());
    let first = mapper.map_json("report", br#"{"ok":true}"#).unwrap();
    let second = mapper.map_json("report", br#"{"ok":true}"#).unwrap();
    assert_eq!(first, second);
}
