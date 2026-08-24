use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, ValueEnum};
use json2leaf::{Config, Graph, InsertSqlWriter, Mapper, SqlWriter};
use walkdir::WalkDir;

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Format {
    Dot,
    Json,
    Sql,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum SqlMode {
    Copy,
    Insert,
}

#[derive(Debug, Parser)]
#[command(version, about)]
struct Arguments {
    /// A JSON or XML file, or a directory that contains these files.
    input: PathBuf,

    /// The output file. The default is output.sql for SQL output.
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// The output data format.
    #[arg(short, long, value_enum, default_value_t = Format::Sql)]
    format: Format,

    /// A JSON configuration file.
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// The PostgreSQL load method.
    #[arg(long, value_enum, default_value_t = SqlMode::Copy)]
    sql_mode: SqlMode,
}

fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let config = load_config(arguments.config.as_deref())?;
    let mapper = Mapper::new(config);
    let files = input_files(&arguments.input)?;
    if files.is_empty() {
        bail!("the input contains zero JSON or XML files");
    }

    let mut mapped = Vec::with_capacity(files.len());
    for path in &files {
        mapped.push((source_name(path)?, map_file(&mapper, path)?));
    }

    let default_output = match arguments.format {
        Format::Sql => Some(PathBuf::from("output.sql")),
        Format::Dot | Format::Json => None,
    };
    let output = arguments.output.as_ref().or(default_output.as_ref());

    match arguments.format {
        Format::Sql => write_sql(
            output.expect("SQL has a default output"),
            &mapped,
            arguments.sql_mode,
        )?,
        Format::Dot => {
            let mut graph = Graph::new("schema");
            for (name, leaves) in &mapped {
                graph.add_subgraph(name, leaves);
            }
            write_output(output, graph.to_dot().as_bytes())?;
        }
        Format::Json => {
            let json = serde_json::to_vec_pretty(&mapped)?;
            write_output(output, &json)?;
        }
    }

    eprintln!("Mapped {} file(s).", files.len());
    Ok(())
}

fn load_config(path: Option<&Path>) -> Result<Config> {
    let Some(path) = path else {
        return Ok(Config::default());
    };
    let input = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&input).with_context(|| format!("failed to parse {}", path.display()))
}

fn input_files(input: &Path) -> Result<Vec<PathBuf>> {
    if input.is_file() {
        return if supported(input) {
            Ok(vec![input.to_owned()])
        } else {
            bail!("{} has an unsupported file type", input.display())
        };
    }
    if !input.is_dir() {
        bail!("missing input path: {}", input.display());
    }

    let mut files = WalkDir::new(input)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && supported(entry.path()))
        .map(walkdir::DirEntry::into_path)
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "json" | "xml"))
}

fn source_name(path: &Path) -> Result<String> {
    path.file_stem()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .with_context(|| format!("{} has an invalid file name", path.display()))
}

fn map_file(mapper: &Mapper, path: &Path) -> Result<Vec<json2leaf::Leaf>> {
    let input = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    let name = source_name(path)?;
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("xml") => {
            let text = std::str::from_utf8(&input)
                .with_context(|| format!("{} has invalid UTF-8 XML", path.display()))?;
            mapper
                .map_xml(&name, text)
                .with_context(|| format!("failed to parse {}", path.display()))
        }
        _ => mapper
            .map_json(&name, &input)
            .with_context(|| format!("failed to parse {}", path.display())),
    }
}

fn write_sql(path: &Path, mapped: &[(String, Vec<json2leaf::Leaf>)], mode: SqlMode) -> Result<()> {
    let file =
        File::create(path).with_context(|| format!("failed to create {}", path.display()))?;
    match mode {
        SqlMode::Copy => {
            let mut writer = SqlWriter::new(BufWriter::new(file))?;
            for (_, leaves) in mapped {
                writer.write_leaves(leaves)?;
            }
            writer.finish()?;
        }
        SqlMode::Insert => {
            let mut writer = InsertSqlWriter::new(BufWriter::new(file))?;
            for (_, leaves) in mapped {
                writer.write_leaves(leaves)?;
            }
            writer.finish()?;
        }
    }
    Ok(())
}

fn write_output(path: Option<&PathBuf>, bytes: &[u8]) -> Result<()> {
    if let Some(path) = path {
        fs::write(path, bytes).with_context(|| format!("failed to write {}", path.display()))?;
    } else {
        std::io::stdout().lock().write_all(bytes)?;
    }
    Ok(())
}
