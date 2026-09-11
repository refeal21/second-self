//! Exact selected-project SQL text cells; never an embedded shared database.
use rusqlite::{types::ValueRef, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SelectedTable {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}
pub(super) type SelectedRows = BTreeMap<String, SelectedTable>;

/// Non-Deserialize evidence view bound to the enclosing native capture. It is
/// not replay, asset-validation or publication authority.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SelectedEnvelope {
    schema_version: u32,
    hash_algorithm: &'static str,
    sha256: String,
    evidence: SelectedEvidence,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectedEvidence {
    source_project_id: String,
    source_revision: i64,
    source_snapshot_hash_algorithm: &'static str,
    source_snapshot_sha256: String,
    raw_pipeline_hash_algorithm: &'static str,
    raw_pipeline_sha256: String,
    rows: SelectedRows,
}
impl SelectedEnvelope {
    pub(super) fn bind(
        project_id: &str,
        revision: i64,
        snapshot_sha256: &str,
        pipeline_json: &str,
        rows: SelectedRows,
    ) -> Result<Self, String> {
        let evidence = SelectedEvidence {
            source_project_id: project_id.into(),
            source_revision: revision,
            source_snapshot_hash_algorithm: "legacy-source-snapshot-sha256-v1",
            source_snapshot_sha256: snapshot_sha256.into(),
            raw_pipeline_hash_algorithm: "sha256-raw-utf8-v1",
            raw_pipeline_sha256: format!("{:x}", Sha256::digest(pipeline_json.as_bytes())),
            rows,
        };
        let limit = super::legacy_snapshot::DATABASE_FILE_LIMIT;
        let envelope = Self {
            schema_version: 1,
            hash_algorithm: "sha256-serialized-selected-evidence-v1",
            sha256: bounded_hash(&evidence, limit)?,
            evidence,
        };
        // Check the complete serialized view, including digest/domain labels,
        // through a counting hasher rather than allocating a second large JSON.
        bounded_hash(&envelope, limit)?;
        Ok(envelope)
    }
    pub(super) fn rows(&self) -> &SelectedRows {
        &self.evidence.rows
    }
}

fn bounded_hash(value: &impl Serialize, limit: usize) -> Result<String, String> {
    struct Hasher {
        sha: Sha256,
        remaining: usize,
    }
    impl Write for Hasher {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.remaining = self.remaining.checked_sub(bytes.len()).ok_or_else(|| {
                std::io::Error::other("selected legacy envelope exceeds byte limit")
            })?;
            self.sha.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut hasher = Hasher {
        sha: Sha256::new(),
        remaining: limit,
    };
    serde_json::to_writer(&mut hasher, value).map_err(message)?;
    Ok(format!("{:x}", hasher.sha.finalize()))
}

pub(super) fn extract(connection: &Connection, project_id: &str) -> Result<SelectedRows, String> {
    let mut tables = BTreeMap::new();
    for name in [
        "projects",
        "presales_projects",
        "presales_checkpoints",
        "presales_approval_bindings",
        "visual_style_versions",
        "visual_style_locks",
        "visual_generation_records",
        "approvals",
        "artifacts",
        "checkpoints",
    ] {
        if !super::legacy_snapshot::table_exists(connection, name)? {
            continue;
        }
        let key = if name == "projects" {
            "id"
        } else {
            "project_id"
        };
        let mut statement = connection
            .prepare(&format!(
                "SELECT * FROM {name} WHERE {key}=?1 ORDER BY rowid"
            ))
            .map_err(message)?;
        let columns = statement
            .column_names()
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
        let count = columns.len();
        let rows = statement
            .query_map([project_id], |row| {
                (0..count)
                    .map(|i| match row.get_ref(i)? {
                        ValueRef::Null => Ok(Value::Null),
                        ValueRef::Integer(v) => Ok(Value::from(v)),
                        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
                            .map(|v| Value::String(v.into()))
                            .map_err(|e| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    i,
                                    rusqlite::types::Type::Text,
                                    Box::new(e),
                                )
                            }),
                        value => Err(rusqlite::Error::InvalidColumnType(
                            i,
                            columns[i].clone(),
                            value.data_type(),
                        )),
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(message)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(message)?;
        tables.insert(name.into(), SelectedTable { columns, rows });
    }
    bounded_hash(&tables, super::legacy_snapshot::DATABASE_FILE_LIMIT)?;
    Ok(tables)
}

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_budget_counts_json_escape_expansion_before_buffer_allocation() {
        // One NUL becomes six escape bytes plus two JSON quotes.
        assert!(bounded_hash(&"\0", 7).is_err());
        assert!(bounded_hash(&"\0", 8).is_ok());
        assert_ne!(
            bounded_hash(&"\0", 8).unwrap(),
            bounded_hash(&"x", 8).unwrap()
        );
    }
}
