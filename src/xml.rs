use std::collections::HashSet;

use quick_xml::Reader;
use quick_xml::de::DeError;
use quick_xml::escape::unescape;
use quick_xml::events::{BytesRef, BytesStart, Event};
use serde_json::{Map, Value};

use crate::mapper::{Config, Leaf, LeafBuilder, Record};

pub fn xml_to_json(input: &str) -> Result<Value, DeError> {
    let mut reader = Reader::from_str(input);
    reader.config_mut().trim_text(false);

    let mut stack: Vec<XmlNode> = Vec::new();
    let mut root = None;
    let mut run = String::new();

    loop {
        match reader.read_event().map_err(DeError::from)? {
            Event::Start(element) => {
                flush_run(&mut run, stack.last_mut().map(|node| &mut node.text));
                stack.push(XmlNode::from_element(&element)?);
            }
            Event::Empty(element) => {
                flush_run(&mut run, stack.last_mut().map(|node| &mut node.text));
                attach(XmlNode::from_element(&element)?, &mut stack, &mut root)?;
            }
            Event::Text(text) => run.push_str(&unescape(&text.xml_content()?)?),
            Event::CData(text) => run.push_str(&text.xml_content()?),
            Event::GeneralRef(reference) => push_reference(&mut run, &reference)?,
            Event::End(_) => {
                flush_run(&mut run, stack.last_mut().map(|node| &mut node.text));
                let node = stack.pop().ok_or_else(|| {
                    DeError::Custom("XML contains an unmatched closing element".to_owned())
                })?;
                attach(node, &mut stack, &mut root)?;
            }
            Event::Eof => break,
            Event::Decl(_) | Event::PI(_) | Event::DocType(_) | Event::Comment(_) => {}
        }
    }

    if !stack.is_empty() {
        return Err(DeError::UnexpectedEof);
    }
    root.ok_or_else(|| DeError::Custom("XML requires a root element".to_owned()))
}

pub(crate) fn xml_to_leaves(
    config: &Config,
    name: &str,
    input: &str,
) -> Result<Vec<Leaf>, DeError> {
    let repeated = repeated_element_paths(input)?;
    let mut reader = Reader::from_str(input);
    reader.config_mut().trim_text(false);

    let mut builder = LeafBuilder::new(config, name, input.as_bytes());
    let mut stack: Vec<StreamFrame> = Vec::new();
    let mut root_seen = false;
    let mut run = String::new();

    loop {
        match reader.read_event().map_err(DeError::from)? {
            Event::Start(element) => {
                flush_run(&mut run, stack.last_mut().map(|frame| &mut frame.text));
                if stack.is_empty() {
                    require_new_root(&mut root_seen)?;
                }
                let frame = open_stream_frame(&element, &mut stack, &repeated, &mut builder, name)?;
                stack.push(frame);
            }
            Event::Empty(element) => {
                flush_run(&mut run, stack.last_mut().map(|frame| &mut frame.text));
                if stack.is_empty() {
                    require_new_root(&mut root_seen)?;
                }
                let frame = open_stream_frame(&element, &mut stack, &repeated, &mut builder, name)?;
                finish_stream_frame(frame, &mut builder);
            }
            Event::Text(text) => run.push_str(&unescape(&text.xml_content()?)?),
            Event::CData(text) => run.push_str(&text.xml_content()?),
            Event::GeneralRef(reference) => push_reference(&mut run, &reference)?,
            Event::End(_) => {
                flush_run(&mut run, stack.last_mut().map(|frame| &mut frame.text));
                let frame = stack.pop().ok_or_else(|| {
                    DeError::Custom("XML contains an unmatched closing element".to_owned())
                })?;
                finish_stream_frame(frame, &mut builder);
            }
            Event::Eof => break,
            Event::Decl(_) | Event::PI(_) | Event::DocType(_) | Event::Comment(_) => {}
        }
    }

    if !stack.is_empty() {
        return Err(DeError::UnexpectedEof);
    }
    if !root_seen {
        return Err(DeError::Custom("XML requires a root element".to_owned()));
    }
    Ok(builder.finish())
}

fn repeated_element_paths(input: &str) -> Result<HashSet<String>, DeError> {
    let mut reader = Reader::from_str(input);
    reader.config_mut().trim_text(true);
    let mut stack: Vec<ScanFrame> = Vec::new();
    let mut repeated = HashSet::new();
    let mut root_seen = false;

    loop {
        match reader.read_event().map_err(DeError::from)? {
            Event::Start(element) => {
                let name = element_name(&element)?;
                if stack.is_empty() {
                    require_new_root(&mut root_seen)?;
                }
                let path = scan_child_path(&mut stack, &name, &mut repeated);
                stack.push(ScanFrame {
                    path,
                    children: HashSet::new(),
                });
            }
            Event::Empty(element) => {
                let name = element_name(&element)?;
                if stack.is_empty() {
                    require_new_root(&mut root_seen)?;
                }
                scan_child_path(&mut stack, &name, &mut repeated);
            }
            Event::End(_) => {
                stack.pop().ok_or_else(|| {
                    DeError::Custom("XML contains an unmatched closing element".to_owned())
                })?;
            }
            Event::Eof => break,
            Event::Text(_)
            | Event::CData(_)
            | Event::Decl(_)
            | Event::PI(_)
            | Event::DocType(_)
            | Event::Comment(_)
            | Event::GeneralRef(_) => {}
        }
    }

    if !stack.is_empty() {
        return Err(DeError::UnexpectedEof);
    }
    if !root_seen {
        return Err(DeError::Custom("XML requires a root element".to_owned()));
    }
    Ok(repeated)
}

fn require_new_root(root_seen: &mut bool) -> Result<(), DeError> {
    if *root_seen {
        return Err(DeError::Custom("XML requires one document root".to_owned()));
    }
    *root_seen = true;
    Ok(())
}

fn scan_child_path(stack: &mut [ScanFrame], name: &str, repeated: &mut HashSet<String>) -> String {
    let Some(parent) = stack.last_mut() else {
        return name.to_owned();
    };
    let path = absolute_path(&parent.path, name);
    if !parent.children.insert(name.to_owned()) {
        repeated.insert(path.clone());
    }
    path
}

fn open_stream_frame(
    element: &BytesStart<'_>,
    stack: &mut [StreamFrame],
    repeated: &HashSet<String>,
    builder: &mut LeafBuilder<'_>,
    source_name: &str,
) -> Result<StreamFrame, DeError> {
    let element_name = element_name(element)?;
    let (absolute_path, record, prefix) = if let Some(parent) = stack.last_mut() {
        parent.has_children = true;
        let absolute_path = absolute_path(&parent.absolute_path, &element_name);
        let field_path = field_path(&parent.prefix, &element_name);
        if repeated.contains(&absolute_path) {
            (
                absolute_path,
                builder.child(&parent.record, &field_path),
                String::new(),
            )
        } else {
            (absolute_path, parent.record.clone(), field_path)
        }
    } else {
        (
            element_name.clone(),
            builder.root(source_name),
            String::new(),
        )
    };

    let decoder = element.decoder();
    let mut has_attributes = false;
    for attribute in element.attributes() {
        let attribute = attribute?;
        let attribute_name = decoder.decode(attribute.key.as_ref())?;
        let value = attribute.decode_and_unescape_value(decoder)?;
        let path = field_path(&prefix, &format!("@{attribute_name}"));
        builder.add_string(&record, &path, value.into_owned());
        has_attributes = true;
    }

    Ok(StreamFrame {
        absolute_path,
        record,
        prefix,
        has_attributes,
        has_children: false,
        text: String::new(),
    })
}

fn finish_stream_frame(frame: StreamFrame, builder: &mut LeafBuilder<'_>) {
    if frame.has_attributes || frame.has_children {
        if !frame.text.is_empty() {
            builder.add_string(
                &frame.record,
                &field_path(&frame.prefix, "$text"),
                frame.text,
            );
        }
        return;
    }

    let path = if frame.prefix.is_empty() {
        "value".to_owned()
    } else {
        frame.prefix
    };
    builder.add_string(&frame.record, &path, frame.text);
}

/// Adds a run of character data to an element's text. A run is the text, entity references
/// and CDATA between two tags, joined exactly as written; runs are trimmed and separated by
/// a space, as before.
fn flush_run(run: &mut String, text: Option<&mut String>) {
    if let Some(text) = text {
        let value = run.trim();
        if !value.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(value);
        }
    }
    run.clear();
}

/// Resolves an entity or character reference in text. The predefined XML entities and
/// character references become their characters; any other entity is kept as written,
/// because its definition is not available here.
fn push_reference(run: &mut String, reference: &BytesRef<'_>) -> Result<(), DeError> {
    if let Some(character) = reference.resolve_char_ref()? {
        run.push(character);
        return Ok(());
    }
    let name = reference.decode()?;
    match name.as_ref() {
        "amp" => run.push('&'),
        "lt" => run.push('<'),
        "gt" => run.push('>'),
        "apos" => run.push('\''),
        "quot" => run.push('"'),
        other => {
            run.push('&');
            run.push_str(other);
            run.push(';');
        }
    }
    Ok(())
}

fn element_name(element: &BytesStart<'_>) -> Result<String, DeError> {
    Ok(element
        .decoder()
        .decode(element.name().as_ref())?
        .into_owned())
}

fn absolute_path(parent: &str, child: &str) -> String {
    format!("{parent}\u{1f}{child}")
}

fn field_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_owned()
    } else {
        format!("{parent}__{child}")
    }
}

struct ScanFrame {
    path: String,
    children: HashSet<String>,
}

struct StreamFrame {
    absolute_path: String,
    record: Record,
    prefix: String,
    has_attributes: bool,
    has_children: bool,
    text: String,
}

impl StreamFrame {}

#[derive(Debug)]
struct XmlNode {
    name: String,
    fields: Map<String, Value>,
    text: String,
}

impl XmlNode {
    fn from_element(element: &BytesStart<'_>) -> Result<Self, DeError> {
        let decoder = element.decoder();
        let name = decoder.decode(element.name().as_ref())?.into_owned();
        let mut fields = Map::new();

        for attribute in element.attributes() {
            let attribute = attribute?;
            let name = decoder.decode(attribute.key.as_ref())?;
            let value = attribute.decode_and_unescape_value(decoder)?;
            fields.insert(format!("@{name}"), Value::String(value.into_owned()));
        }

        Ok(Self {
            name,
            fields,
            text: String::new(),
        })
    }

    fn into_value(mut self) -> Value {
        if self.fields.is_empty() {
            return Value::String(self.text);
        }
        if !self.text.is_empty() {
            self.fields
                .insert("$text".to_owned(), Value::String(self.text));
        }
        Value::Object(self.fields)
    }

    fn add_child(&mut self, child: XmlNode) {
        let name = child.name.clone();
        let value = child.into_value();
        match self.fields.entry(name) {
            serde_json::map::Entry::Vacant(entry) => {
                entry.insert(value);
            }
            serde_json::map::Entry::Occupied(mut entry) => match entry.get_mut() {
                Value::Array(items) => items.push(value),
                current => {
                    let first = std::mem::replace(current, Value::Null);
                    *current = Value::Array(vec![first, value]);
                }
            },
        }
    }
}

fn attach(node: XmlNode, stack: &mut [XmlNode], root: &mut Option<Value>) -> Result<(), DeError> {
    if let Some(parent) = stack.last_mut() {
        parent.add_child(node);
        return Ok(());
    }
    if root.is_some() {
        return Err(DeError::Custom("XML requires one document root".to_owned()));
    }
    *root = Some(node.into_value());
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::Mapper;

    #[test]
    fn converts_xml_to_a_json_value() {
        let value = xml_to_json("<report><title>One</title><count>2</count></report>").unwrap();
        assert_eq!(value["title"], "One");
        assert_eq!(value["count"], "2");
    }

    #[test]
    fn preserves_attributes_namespaces_and_repeated_elements() {
        let value = xml_to_json(
            r#"<report code="A"><x:item unit="GBP">2</x:item><x:item>3</x:item></report>"#,
        )
        .unwrap();

        assert_eq!(value["@code"], "A");
        assert_eq!(
            value["x:item"],
            json!([{ "@unit": "GBP", "$text": "2" }, "3"])
        );
    }

    #[test]
    fn maps_repeated_xml_elements_as_linked_records() {
        let leaves = Mapper::new(Config::default())
            .map_xml(
                "catalog",
                r#"<catalog code="A"><group><item unit="GBP">2</item><item>3</item></group></catalog>"#,
            )
            .unwrap();

        assert!(
            leaves.iter().any(|leaf| {
                leaf.name == "catalog" && leaf.path == "@code" && leaf.value == "A"
            })
        );
        assert!(leaves.iter().any(|leaf| {
            leaf.name == "catalog__group__item" && leaf.path == "@unit" && leaf.value == "GBP"
        }));
        assert!(leaves.iter().any(|leaf| {
            leaf.name == "catalog__group__item" && leaf.path == "$text" && leaf.value == "2"
        }));
        assert!(leaves.iter().any(|leaf| {
            leaf.name == "catalog__group__item" && leaf.path == "value" && leaf.value == "3"
        }));

        let root = leaves
            .iter()
            .find(|leaf| leaf.name == "_tree" && leaf.parent_id.is_none())
            .unwrap();
        let children = leaves
            .iter()
            .filter(|leaf| leaf.name == "_tree" && leaf.parent_id.as_deref() == Some(&root.id))
            .count();
        assert_eq!(children, 2);
    }
}
