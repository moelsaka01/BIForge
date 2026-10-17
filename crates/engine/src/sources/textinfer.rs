//! Sources that deliver only text (HTML tables, XML, PDF, fixed-width files, web APIs) get typed columns here:
//! a column whose non-empty cells all read as whole numbers, numbers, booleans or dates becomes that type.
use super::{Cell, RawTable};
use chrono::{NaiveDate, NaiveDateTime};

fn parse_ts(s: &str) -> Option<i64> {
    let s = s.trim();
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M"] {
        if let Ok(d) = NaiveDateTime::parse_from_str(s, f) {
            return Some(d.and_utc().timestamp_micros());
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_micros())
}

fn is_int(s: &str) -> bool {
    let t = s.strip_prefix('-').unwrap_or(s);
    !t.is_empty() && t.len() <= 18 && t.bytes().all(|b| b.is_ascii_digit()) && (t == "0" || !t.starts_with('0'))
}

fn is_float(s: &str) -> bool {
    let t = s.strip_prefix('-').unwrap_or(s);
    t.bytes().any(|b| b.is_ascii_digit()) && s.parse::<f64>().is_ok() && t.bytes().all(|b| b.is_ascii_digit() || b == b'.' || b == b'e' || b == b'E' || b == b'+' || b == b'-')
}

/// Converts text cells to typed cells column by column. Empty strings become null in typed columns and stay empty text otherwise.
pub fn infer(mut raw: RawTable) -> RawTable {
    for c in 0..raw.columns.len() {
        if raw.rows.iter().any(|r| !matches!(r[c], Cell::Text(_) | Cell::Null)) {
            continue;
        }
        let leading_zero = |s: &str| s.len() > 1 && s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit());
        let vals: Vec<String> = raw.rows.iter().filter_map(|r| match &r[c] { Cell::Text(s) if !s.trim().is_empty() => Some(s.trim().to_string()), _ => None }).collect();
        if vals.is_empty() || vals.iter().any(|v| leading_zero(v)) {
            continue;
        }
        let conv: Option<fn(&str) -> Cell> = if vals.iter().all(|v| is_int(v)) {
            Some(|s| Cell::Int(s.parse().unwrap()))
        } else if vals.iter().all(|v| is_int(v) || is_float(v)) {
            Some(|s| Cell::Float(s.parse().unwrap()))
        } else if vals.iter().all(|v| v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("false")) {
            Some(|s| Cell::Bool(s.eq_ignore_ascii_case("true")))
        } else if vals.iter().all(|v| parse_ts(v).is_some()) {
            Some(|s| Cell::Timestamp(parse_ts(s).unwrap()))
        } else {
            None
        };
        if let Some(f) = conv {
            for r in raw.rows.iter_mut() {
                r[c] = match &r[c] {
                    Cell::Text(s) if !s.trim().is_empty() => f(s.trim()),
                    _ => Cell::Null,
                };
            }
        }
    }
    raw
}

#[cfg(test)]
mod tests {
    use super::*;
    fn t(rows: &[&[&str]]) -> RawTable {
        RawTable { columns: (0..rows[0].len()).map(|i| format!("c{i}")).collect(), rows: rows.iter().map(|r| r.iter().map(|s| Cell::Text(s.to_string())).collect()).collect() }
    }
    #[test]
    fn columns_get_the_narrowest_type_that_fits_every_cell() {
        let r = infer(t(&[&["1", "1.5", "true", "2024-01-02", "007", "1"], &["", "2", "False", "2024-01-03 10:00:00", "8", "x"]]));
        assert_eq!(r.rows[0][0], Cell::Int(1));
        assert_eq!(r.rows[1][0], Cell::Null);
        assert_eq!(r.rows[0][1], Cell::Float(1.5));
        assert_eq!(r.rows[1][1], Cell::Float(2.0));
        assert_eq!(r.rows[1][2], Cell::Bool(false));
        assert!(matches!(r.rows[0][3], Cell::Timestamp(_)));
        assert_eq!(r.rows[0][4], Cell::Text("007".into())); // leading zeros stay text (codes, zip codes)
        assert_eq!(r.rows[1][5], Cell::Text("x".into()));
    }
}
