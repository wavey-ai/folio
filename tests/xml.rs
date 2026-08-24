#![cfg(feature = "xml")]

use std::fs;

use json2leaf::{Config, Mapper};

#[test]
#[ignore = "large sample"]
fn maps_the_discogs_releases_sample() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/web/samples/discogs-releases.xml"
    );
    let input = fs::read_to_string(path).unwrap();
    let leaves = Mapper::new(Config::default())
        .map_xml("discogs_releases", &input)
        .unwrap();

    assert!(leaves.len() > 900_000);
    assert!(
        leaves
            .iter()
            .any(|leaf| leaf.name.ends_with("__release__artists__artist"))
    );
    assert!(
        leaves
            .iter()
            .any(|leaf| leaf.name.ends_with("__release__tracklist__track"))
    );
}
