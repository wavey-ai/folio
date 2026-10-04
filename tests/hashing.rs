use std::collections::BTreeMap;

use json2leaf::{Config, Leaf, Mapper, value_hash};

fn map(input: &[u8]) -> Vec<Leaf> {
    Mapper::new(Config::default())
        .map_json("report", input)
        .unwrap()
}

fn keys_by_field(leaves: &[Leaf]) -> BTreeMap<(String, String, String), String> {
    leaves
        .iter()
        .filter(|leaf| leaf.name != "_tree")
        .map(|leaf| {
            (
                (leaf.name.clone(), leaf.path.clone(), leaf.value_text()),
                leaf.key.to_string(),
            )
        })
        .collect()
}

#[test]
fn record_keys_survive_value_edits() {
    let before = map(br#"{"title":"Q1","items":[{"amount":"10"},{"amount":"20"}]}"#);
    let after = map(br#"{"title":"Q2","items":[{"amount":"10"},{"amount":"25"}]}"#);

    // Row ids depend on the whole document, so an edit changes all of them.
    assert_ne!(before[0].id, after[0].id);

    let key = |leaves: &[Leaf], path: &str, value: &str| {
        leaves
            .iter()
            .find(|leaf| leaf.path == path && leaf.value_text() == value)
            .unwrap()
            .key
            .to_string()
    };
    assert_eq!(key(&before, "title", "Q1"), key(&after, "title", "Q2"));
    assert_eq!(key(&before, "amount", "10"), key(&after, "amount", "10"));
    assert_eq!(key(&before, "amount", "20"), key(&after, "amount", "25"));
}

#[test]
fn appending_an_item_keeps_earlier_keys() {
    let before = keys_by_field(&map(br#"{"items":[{"n":"a"},{"n":"b"}]}"#));
    let after = keys_by_field(&map(br#"{"items":[{"n":"a"},{"n":"b"},{"n":"c"}]}"#));

    for (field, key) in &before {
        assert_eq!(after.get(field), Some(key), "{field:?}");
    }
    assert_eq!(after.len(), before.len() + 1);
}

#[test]
fn records_and_parents_have_distinct_linked_keys() {
    let leaves = map(br#"{"items":[{"n":"a"},{"n":"b"}]}"#);
    let root = leaves
        .iter()
        .find(|leaf| leaf.name == "_tree" && leaf.parent_id.is_none())
        .unwrap();
    let items: Vec<&Leaf> = leaves
        .iter()
        .filter(|leaf| leaf.name == "report__items")
        .collect();

    assert_eq!(items.len(), 2);
    assert_ne!(items[0].key, items[1].key);
    for item in items {
        assert_eq!(item.parent_key.as_deref(), Some(&*root.key));
        assert_eq!(item.key.len(), 32);
    }
}

#[test]
fn path_hashes_keep_original_key_spellings_apart() {
    let leaves =
        map(br#"{"postCode":"A1","post_code":"B2","Property__c":"x","Property":{"c":"y"}}"#);
    let hash = |value: &str| {
        leaves
            .iter()
            .find(|leaf| leaf.value_text() == value)
            .unwrap()
            .path_hash
    };

    // The snake_case paths collide, but the path hashes do not.
    let paths: Vec<&str> = leaves
        .iter()
        .filter(|leaf| leaf.value_text() == "A1" || leaf.value_text() == "B2")
        .map(|leaf| leaf.path.as_str())
        .collect();
    assert_eq!(paths, ["post_code", "post_code"]);
    assert_ne!(hash("A1"), hash("B2"));
    assert_ne!(hash("x"), hash("y"));
}

#[test]
fn same_field_in_different_records_shares_a_path_hash() {
    let leaves = map(br#"{"items":[{"amount":"1"},{"amount":"2"}]}"#);
    let hashes: Vec<i64> = leaves
        .iter()
        .filter(|leaf| leaf.path == "amount")
        .map(|leaf| leaf.path_hash)
        .collect();
    assert_eq!(hashes.len(), 2);
    assert_eq!(hashes[0], hashes[1]);
}

#[test]
fn numbers_keep_their_source_text() {
    let leaves = map(br#"{"rent":2.50,"big":12345678901234567890.125,"exp":1e3}"#);
    let texts: Vec<String> = leaves
        .iter()
        .filter(|leaf| leaf.name != "_tree")
        .map(Leaf::value_text)
        .collect();

    assert!(texts.contains(&"2.50".to_owned()));
    assert!(texts.contains(&"12345678901234567890.125".to_owned()));
    // serde_json keeps every digit but writes exponents with an explicit sign.
    assert!(texts.contains(&"1e+3".to_owned()));
}

#[test]
fn value_hashes_are_of_the_exact_text() {
    let leaves = map(br#"{"a":"000731","b":731,"c":"Smith & Sons Ltd"}"#);
    for leaf in leaves.iter().filter(|leaf| leaf.name != "_tree") {
        assert_eq!(leaf.value_hash(), value_hash(&leaf.value_text()));
    }
    let hash = |text: &str| {
        leaves
            .iter()
            .find(|leaf| leaf.value_text() == text)
            .unwrap()
            .value_hash()
    };
    assert_ne!(hash("000731"), hash("731"));
    assert_eq!(hash("Smith & Sons Ltd"), 5_301_750_890_647_567_476);
}

#[test]
fn path_hashes_serialize_as_strings() {
    let leaves = map(br#"{"a":"1"}"#);
    let json = serde_json::to_value(&leaves[1]).unwrap();
    assert!(json["path_hash"].is_string());

    let round_trip: Leaf = serde_json::from_value(json).unwrap();
    assert_eq!(round_trip, leaves[1]);
}

#[cfg(feature = "xml")]
#[test]
fn xml_repeated_elements_get_stable_keys() {
    let mapper = Mapper::new(Config::default());
    let before = mapper
        .map_xml("catalog", "<catalog><item>a</item><item>b</item></catalog>")
        .unwrap();
    let after = mapper
        .map_xml(
            "catalog",
            "<catalog><item>a</item><item>changed</item></catalog>",
        )
        .unwrap();

    let item_keys = |leaves: &[Leaf]| -> Vec<String> {
        leaves
            .iter()
            .filter(|leaf| leaf.name != "_tree")
            .map(|leaf| leaf.key.to_string())
            .collect()
    };
    let before_keys = item_keys(&before);
    assert_eq!(before_keys.len(), 2);
    assert_ne!(before_keys[0], before_keys[1]);
    assert_eq!(before_keys, item_keys(&after));
}

#[test]
fn stable_keys_can_be_skipped() {
    let config = Config {
        skip_stable_keys: true,
        ..Config::default()
    };
    let skipped = Mapper::new(config)
        .map_json("report", br#"{"items":[{"n":"a"}]}"#)
        .unwrap();
    let full = map(br#"{"items":[{"n":"a"}]}"#);

    assert!(
        skipped
            .iter()
            .all(|leaf| leaf.key.is_empty() && leaf.path_hash == 0)
    );
    let ids =
        |leaves: &[Leaf]| -> Vec<String> { leaves.iter().map(|leaf| leaf.id.clone()).collect() };
    assert_eq!(ids(&skipped), ids(&full));
}
