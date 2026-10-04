//! Stable hashes for leaf rows.
//!
//! Every hash is a truncated SHA-256 digest. SHA-256 gives identical results in
//! Rust (native and Wasm), in browsers (WebCrypto) and in PostgreSQL, where
//! `sha256()` is built in from version 11. See `docs/hashing.md`.

use sha2::{Digest, Sha256};

const PATH_TAG: &[u8] = b"folio:path:v1";
const RECORD_TAG: &[u8] = b"folio:rec:v1";

/// A 128-bit record key.
pub type RecordKey = [u8; 16];

/// The first 8 bytes of SHA-256 of `bytes`, read as a big-endian signed integer.
///
/// For text, this equals `folio_h64(text)` in the generated SQL.
#[must_use]
pub fn h64(bytes: &[u8]) -> i64 {
    let digest = Sha256::digest(bytes);
    let mut prefix = [0; 8];
    prefix.copy_from_slice(&digest[..8]);
    i64::from_be_bytes(prefix)
}

/// The hash of a value's exact text, as stored in `nodes.value`.
#[must_use]
pub fn value_hash(text: &str) -> i64 {
    h64(text.as_bytes())
}

/// One step of a path, kept in its original spelling.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) enum Part {
    /// The source name of a root record.
    Source(String),
    /// An object key, or an XML field path.
    Key(String),
    /// A step into the items of an array.
    Items,
    /// A field promoted to its own table by `table_names`.
    Table,
    /// A field moved by a column override.
    Override(String),
    /// A scalar array item, stored under the path `value`.
    ScalarItem,
    /// The structural `_tree` row of a record.
    Tree,
}

impl Part {
    fn write(&self, digest: &mut Sha256) {
        match self {
            Self::Source(text) => write_text(digest, 1, text),
            Self::Key(text) => write_text(digest, 2, text),
            Self::Items => digest.update([3]),
            Self::Table => digest.update([4]),
            Self::Override(text) => write_text(digest, 5, text),
            Self::ScalarItem => digest.update([6]),
            Self::Tree => digest.update([7]),
        }
    }
}

fn write_text(digest: &mut Sha256, kind: u8, text: &str) {
    let length = u32::try_from(text.len()).unwrap_or(u32::MAX);
    digest.update([kind]);
    digest.update(length.to_be_bytes());
    digest.update(text.as_bytes());
}

/// The hash of a field: its record type path followed by its path inside the record.
pub(crate) fn path_hash(record_type: &[Part], field: &[Part]) -> i64 {
    let mut digest = Sha256::new();
    digest.update(PATH_TAG);
    for part in record_type {
        part.write(&mut digest);
    }
    digest.update([0]);
    for part in field {
        part.write(&mut digest);
    }
    let digest = digest.finalize();
    let mut prefix = [0; 8];
    prefix.copy_from_slice(&digest[..8]);
    i64::from_be_bytes(prefix)
}

/// The key of a record, derived from its parent's key and the steps that lead to it.
pub(crate) fn record_key(
    parent: Option<&RecordKey>,
    steps: &[Part],
    index: Option<u64>,
) -> RecordKey {
    let mut digest = Sha256::new();
    digest.update(RECORD_TAG);
    match parent {
        Some(parent) => {
            digest.update([1]);
            digest.update(parent);
        }
        None => digest.update([0]),
    }
    for step in steps {
        step.write(&mut digest);
    }
    if let Some(index) = index {
        digest.update([8]);
        digest.update(index.to_be_bytes());
    }
    let digest = digest.finalize();
    let mut key = [0; 16];
    key.copy_from_slice(&digest[..16]);
    key
}

/// A record key as 32 lowercase hex digits, which PostgreSQL accepts as a `uuid`.
pub(crate) fn key_hex(key: &RecordKey) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(32);
    for byte in key {
        text.push(char::from(DIGITS[usize::from(byte >> 4)]));
        text.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    text
}

/// Serializes an `i64` as a decimal string, so JavaScript readers keep every digit.
pub(crate) mod i64_string {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    #[allow(clippy::trivially_copy_pass_by_ref)]
    pub(crate) fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(D::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_postgres_folio_h64() {
        // Computed in PostgreSQL 18 with the `folio_h64` definition in sql.rs.
        assert_eq!(value_hash("Smith & Sons Ltd"), 5_301_750_890_647_567_476);
        assert_eq!(value_hash("café"), -8_858_723_660_289_998_967);
        assert_eq!(value_hash("000731"), 2_184_166_409_188_743_760);
        assert_eq!(value_hash("731"), -986_540_773_525_597_110);
        assert_eq!(value_hash("731.0"), 7_249_036_988_491_400_777);
    }

    #[test]
    fn separates_key_spellings_and_nesting() {
        let root = [Part::Source("report".to_owned())];
        let flat = path_hash(&root, &[Part::Key("Property__c".to_owned())]);
        let nested = path_hash(
            &root,
            &[Part::Key("Property".to_owned()), Part::Key("c".to_owned())],
        );
        let camel = path_hash(&root, &[Part::Key("postCode".to_owned())]);
        let snake = path_hash(&root, &[Part::Key("post_code".to_owned())]);
        let item = path_hash(&root, &[Part::ScalarItem]);
        let value = path_hash(&root, &[Part::Key("value".to_owned())]);

        assert_ne!(flat, nested);
        assert_ne!(camel, snake);
        assert_ne!(item, value);
    }

    #[test]
    fn formats_keys_as_uuid_hex() {
        let key = record_key(None, &[Part::Source("report".to_owned())], None);
        let hex = key_hex(&key);
        assert_eq!(hex.len(), 32);
        assert!(hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
