#![cfg(feature = "xml")]

use std::fs;

use json2leaf::{Config, Mapper, xml_to_json};

#[test]
#[ignore = "large sample"]
fn maps_the_reactome_pathways_sample() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/samples/reactome-pathways.xml"
    );
    let input = fs::read_to_string(path).unwrap();
    let document = xml_to_json(&input).unwrap();
    let leaves = Mapper::new(Config::default()).map_value("reactome_pathways", &document);

    assert!(leaves.len() > 600_000);
    assert!(
        leaves
            .iter()
            .any(|leaf| leaf.name.ends_with("__bp:pathway"))
    );
    assert!(
        leaves
            .iter()
            .any(|leaf| leaf.name.ends_with("__bp:biochemical_reaction"))
    );
}
