use std::sync::OnceLock;

use regex::Regex;

fn person_name_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"[A-Z](?:[a-z]+|\.)(?:\s+[A-Z](?:[a-z]+|\.))*(?:\s+[a-z][a-z-]+){0,2}\s+[A-Z](?:[a-z]+|\.)",
        )
        .expect("the person-name pattern is valid")
    })
}

#[must_use]
pub fn redact(value: &str) -> (String, bool) {
    let pattern = person_name_pattern();
    let matched = pattern.is_match(value);
    (
        pattern.replace_all(value, "[PII redacted]").into_owned(),
        matched,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_a_full_name() {
        assert_eq!(
            redact("contact Alice Smith today"),
            ("contact [PII redacted] today".to_owned(), true)
        );
    }
}
