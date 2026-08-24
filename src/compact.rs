use std::collections::HashMap;

use serde_json::Value;

use crate::{DataType, Leaf};

pub(crate) const MAGIC: &[u8; 8] = b"J2LFC001";

pub(crate) fn encode(leaves: &[Leaf]) -> Result<Vec<u8>, String> {
    let row_count = u32::try_from(leaves.len())
        .map_err(|_| "The document has too many rows for the browser format".to_owned())?;
    let prefix = leaves
        .first()
        .and_then(|leaf| leaf.id.rsplit_once('-'))
        .map_or("", |(prefix, _)| prefix);
    let (names, name_ids) = dictionary(leaves.iter().map(|leaf| leaf.name.as_str()))?;
    let (paths, path_ids) = dictionary(leaves.iter().map(|leaf| leaf.path.as_str()))?;

    let mut output = Vec::with_capacity(leaves.len().saturating_mul(28));
    output.extend_from_slice(MAGIC);
    write_u32(&mut output, row_count);
    write_string(&mut output, prefix)?;
    write_dictionary(&mut output, &names)?;
    write_dictionary(&mut output, &paths)?;

    for leaf in leaves {
        write_u32(&mut output, id_number(&leaf.id, prefix)?);
        let parent = leaf
            .parent_id
            .as_deref()
            .map(|id| {
                id_number(id, prefix)?.checked_add(1).ok_or_else(|| {
                    "The document has too many parent rows for the browser format".to_owned()
                })
            })
            .transpose()?
            .unwrap_or(0);
        write_u32(&mut output, parent);
        write_u32(&mut output, name_ids[leaf.name.as_str()]);
        write_u32(&mut output, path_ids[leaf.path.as_str()]);
        output.push(match leaf.data_type {
            DataType::String => 0,
            DataType::Number => 1,
            DataType::Boolean => 2,
        });
        write_value(&mut output, &leaf.value)?;
    }

    Ok(output)
}

fn dictionary<'a>(
    values: impl Iterator<Item = &'a str>,
) -> Result<(Vec<&'a str>, HashMap<&'a str, u32>), String> {
    let mut items = Vec::new();
    let mut ids = HashMap::new();
    for value in values {
        if ids.contains_key(value) {
            continue;
        }
        let id = u32::try_from(items.len())
            .map_err(|_| "The document has too many schema names".to_owned())?;
        items.push(value);
        ids.insert(value, id);
    }
    Ok((items, ids))
}

fn id_number(id: &str, prefix: &str) -> Result<u32, String> {
    let (actual_prefix, suffix) = id
        .rsplit_once('-')
        .ok_or_else(|| format!("Invalid document row identifier: {id}"))?;
    if actual_prefix != prefix {
        return Err("Document row identifiers use different prefixes".to_owned());
    }
    u32::from_str_radix(suffix, 16).map_err(|_| format!("Invalid document row identifier: {id}"))
}

fn write_dictionary(output: &mut Vec<u8>, values: &[&str]) -> Result<(), String> {
    write_u32(
        output,
        u32::try_from(values.len()).map_err(|_| "The schema dictionary is too large".to_owned())?,
    );
    for value in values {
        write_string(output, value)?;
    }
    Ok(())
}

fn write_value(output: &mut Vec<u8>, value: &Value) -> Result<(), String> {
    match value {
        Value::String(value) => write_string(output, value),
        Value::Number(value) => write_string(output, &value.to_string()),
        Value::Bool(value) => write_string(output, if *value { "true" } else { "false" }),
        _ => Err("Document rows must contain scalar values".to_owned()),
    }
}

fn write_string(output: &mut Vec<u8>, value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    write_u32(
        output,
        u32::try_from(bytes.len()).map_err(|_| "A document value is too large".to_owned())?,
    );
    output.extend_from_slice(bytes);
    Ok(())
}

fn write_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn packs_rows_with_dictionaries_and_numeric_links() {
        let leaves = vec![
            Leaf {
                data_type: DataType::String,
                name: "_tree".to_owned(),
                id: "abcdef-0".to_owned(),
                parent_id: None,
                path: "name".to_owned(),
                value: json!("report"),
            },
            Leaf {
                data_type: DataType::Number,
                name: "report".to_owned(),
                id: "abcdef-1".to_owned(),
                parent_id: Some("abcdef-0".to_owned()),
                path: "amount".to_owned(),
                value: json!(12.5),
            },
        ];

        let packed = encode(&leaves).unwrap();
        assert_eq!(&packed[..8], MAGIC);
        assert!(packed.len() < serde_json::to_vec(&leaves).unwrap().len());
    }
}
