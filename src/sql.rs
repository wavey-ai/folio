use std::io::{self, Write};

use serde_json::Value;

use crate::{DataType, Leaf};

const SCHEMA: &str = "DROP TABLE IF EXISTS nodes CASCADE;\n\
\n\
CREATE TABLE nodes (\n\
    id TEXT NOT NULL,\n\
    parent_id TEXT,\n\
    name TEXT NOT NULL,\n\
    path TEXT NOT NULL,\n\
    data_type TEXT NOT NULL,\n\
    value TEXT\n\
);\n\n";

pub struct SqlWriter<W: Write> {
    writer: W,
    started: bool,
}

pub struct InsertSqlWriter<W: Write> {
    writer: W,
}

impl<W: Write> InsertSqlWriter<W> {
    pub fn new(mut writer: W) -> io::Result<Self> {
        writer.write_all(SCHEMA.as_bytes())?;
        Ok(Self { writer })
    }

    pub fn write_leaves(&mut self, leaves: &[Leaf]) -> io::Result<()> {
        for leaf in leaves {
            let parent = leaf
                .parent_id
                .as_deref()
                .map_or_else(|| "NULL".to_owned(), sql_literal);
            writeln!(
                self.writer,
                "INSERT INTO nodes (id, parent_id, name, path, data_type, value) VALUES ({}, {}, {}, {}, {}, {});",
                sql_literal(&leaf.id),
                parent,
                sql_literal(&clean_name(&leaf.name)),
                sql_literal(&leaf.path),
                sql_literal(&leaf.data_type.to_string()),
                sql_literal(&plain_value(&leaf.value, leaf.data_type)),
            )?;
        }
        self.writer.flush()
    }

    pub fn finish(mut self) -> io::Result<W> {
        self.writer.flush()?;
        Ok(self.writer)
    }
}

impl<W: Write> SqlWriter<W> {
    pub fn new(mut writer: W) -> io::Result<Self> {
        writer.write_all(SCHEMA.as_bytes())?;
        Ok(Self {
            writer,
            started: false,
        })
    }

    pub fn write_leaves(&mut self, leaves: &[Leaf]) -> io::Result<()> {
        if !self.started {
            self.writer.write_all(
                b"COPY nodes (id, parent_id, name, path, data_type, value) FROM stdin;\n",
            )?;
            self.started = true;
        }

        for leaf in leaves {
            let parent = leaf
                .parent_id
                .as_deref()
                .map_or("\\N".to_owned(), escape_copy);
            let value = format_value(&leaf.value, leaf.data_type);
            writeln!(
                self.writer,
                "{}\t{}\t{}\t{}\t{}\t{}",
                escape_copy(&leaf.id),
                parent,
                escape_copy(&clean_name(&leaf.name)),
                escape_copy(&leaf.path),
                leaf.data_type,
                value
            )?;
        }
        self.writer.flush()
    }

    pub fn finish(mut self) -> io::Result<W> {
        if self.started {
            self.writer.write_all(b"\\.\n")?;
        }
        self.writer.flush()?;
        Ok(self.writer)
    }
}

pub fn leaves_to_sql<'a>(leaf_sets: impl IntoIterator<Item = &'a [Leaf]>) -> io::Result<String> {
    let mut writer = SqlWriter::new(Vec::new())?;
    for leaves in leaf_sets {
        writer.write_leaves(leaves)?;
    }
    let bytes = writer.finish()?;
    String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub fn leaves_to_insert_sql<'a>(
    leaf_sets: impl IntoIterator<Item = &'a [Leaf]>,
) -> io::Result<String> {
    let mut writer = InsertSqlWriter::new(Vec::new())?;
    for leaves in leaf_sets {
        writer.write_leaves(leaves)?;
    }
    let bytes = writer.finish()?;
    String::from_utf8(bytes).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn format_value(value: &Value, data_type: DataType) -> String {
    escape_copy(&plain_value(value, data_type))
}

fn plain_value(value: &Value, data_type: DataType) -> String {
    match data_type {
        DataType::String => value.as_str().unwrap_or_default().to_owned(),
        DataType::Boolean | DataType::Number => value.to_string(),
    }
}

fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn escape_copy(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\0' => {}
            '\\' => output.push_str("\\\\"),
            '\t' => output.push_str("\\t"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            _ => output.push(character),
        }
    }
    output
}

fn clean_name(value: &str) -> String {
    let parts: Vec<&str> = value.split("__").collect();
    parts
        .iter()
        .enumerate()
        .filter(|(_, part)| !is_md5(part))
        .map(|(_, part)| *part)
        .collect::<Vec<_>>()
        .join("__")
}

fn is_md5(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use crate::{Config, Mapper};

    use super::*;

    #[test]
    fn writes_postgres_copy_data() {
        let leaves = Mapper::new(Config::default())
            .map_json("report", b"{\"text\":\"one\\ttwo\"}")
            .unwrap();
        let sql = leaves_to_sql([leaves.as_slice()]).unwrap();

        assert!(sql.contains("CREATE TABLE nodes"));
        assert!(sql.contains("one\\ttwo"));
        assert!(sql.ends_with("\\.\n"));
    }

    #[test]
    fn writes_postgres_insert_data() {
        let leaves = Mapper::new(Config::default())
            .map_json("report", br#"{"text":"Jamie's report"}"#)
            .unwrap();
        let sql = leaves_to_insert_sql([leaves.as_slice()]).unwrap();

        assert!(sql.contains("CREATE TABLE nodes"));
        assert!(sql.contains("'Jamie''s report'"));
        assert!(sql.contains("INSERT INTO nodes"));
    }
}
