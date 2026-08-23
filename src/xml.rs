use quick_xml::de::from_str;
use serde_json::Value;

pub fn xml_to_json(input: &str) -> Result<Value, quick_xml::DeError> {
    from_str(input).map(normalize)
}

fn normalize(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Object(mut items) => {
            if items.len() == 1 && items.contains_key("$text") {
                return normalize(items.remove("$text").expect("the text entry exists"));
            }
            Value::Object(
                items
                    .into_iter()
                    .map(|(key, value)| (key, normalize(value)))
                    .collect(),
            )
        }
        value => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_xml_to_a_json_value() {
        let value = xml_to_json("<report><title>One</title><count>2</count></report>").unwrap();
        assert_eq!(value["title"], "One");
        assert_eq!(value["count"], "2");
    }
}
