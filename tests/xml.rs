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

#[test]
fn keeps_entity_and_character_references() {
    let input = "<r>\
        <a>Dom &amp; Roland</a>\
        <b>AT&amp;T</b>\
        <c>caf&#233; &#x2122;</c>\
        <d>&lt;tag&gt; &quot;q&quot; &apos;s&apos;</d>\
        <e>x<![CDATA[ & y]]></e>\
        <f> mixed <i>bold</i> tail </f>\
        <g>&custom;</g>\
        </r>";
    let leaves = Mapper::new(Config::default()).map_xml("r", input).unwrap();
    let value = |path: &str| {
        leaves
            .iter()
            .find(|leaf| leaf.name != "_tree" && leaf.path == path)
            .and_then(|leaf| leaf.value.as_str())
            .unwrap()
            .to_owned()
    };

    assert_eq!(value("a"), "Dom & Roland");
    assert_eq!(value("b"), "AT&T");
    assert_eq!(value("c"), "café ™");
    assert_eq!(value("d"), "<tag> \"q\" 's'");
    assert_eq!(value("e"), "x & y");
    assert_eq!(value("f__$text"), "mixed tail");
    assert_eq!(value("f__i"), "bold");
    assert_eq!(value("g"), "&custom;");
}

#[test]
fn xml_to_json_keeps_entity_references() {
    let value = json2leaf::xml_to_json("<r><a>Dom &amp; Roland</a><b>AT&amp;T</b></r>").unwrap();
    assert_eq!(value["a"], "Dom & Roland");
    assert_eq!(value["b"], "AT&T");
}
