use quick_xml::Reader;
use quick_xml::de::DeError;
use quick_xml::escape::unescape;
use quick_xml::events::{BytesStart, Event};
use serde_json::{Map, Value};

pub fn xml_to_json(input: &str) -> Result<Value, DeError> {
    let mut reader = Reader::from_str(input);
    reader.config_mut().trim_text(true);

    let mut stack = Vec::new();
    let mut root = None;

    loop {
        match reader.read_event().map_err(DeError::from)? {
            Event::Start(element) => stack.push(XmlNode::from_element(&element)?),
            Event::Empty(element) => {
                attach(XmlNode::from_element(&element)?, &mut stack, &mut root)?;
            }
            Event::Text(text) => {
                if let Some(node) = stack.last_mut() {
                    let decoded = text.xml_content()?;
                    node.add_text(unescape(&decoded)?.as_ref());
                }
            }
            Event::CData(text) => {
                if let Some(node) = stack.last_mut() {
                    node.add_text(text.xml_content()?.as_ref());
                }
            }
            Event::End(_) => {
                let node = stack.pop().ok_or_else(|| {
                    DeError::Custom("XML contains an unmatched closing element".to_owned())
                })?;
                attach(node, &mut stack, &mut root)?;
            }
            Event::Eof => break,
            Event::Decl(_)
            | Event::PI(_)
            | Event::DocType(_)
            | Event::Comment(_)
            | Event::GeneralRef(_) => {}
        }
    }

    if !stack.is_empty() {
        return Err(DeError::UnexpectedEof);
    }
    root.ok_or_else(|| DeError::Custom("XML requires a root element".to_owned()))
}

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

    fn add_text(&mut self, value: &str) {
        let value = value.trim();
        if value.is_empty() {
            return;
        }
        if !self.text.is_empty() {
            self.text.push(' ');
        }
        self.text.push_str(value);
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
}
