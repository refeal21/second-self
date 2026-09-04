use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};

pub struct Database {
    connection: Connection,
}

#[derive(Clone, Debug)]
pub struct NewProject {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct ProjectMutation {
    pub workflow_status: String,
    pub progress: i64,
    pub selected_slide: i64,
    pub slide_statuses: Vec<String>,
    pub export_ready: bool,
    pub slide_notice: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreferenceSnapshot {
    pub proposal_id: String,
    pub title: String,
    pub content: String,
    pub approved_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredProject {
    pub id: String,
    pub name: String,
    pub goal: String,
    pub workflow_status: String,
    pub progress: i64,
    pub selected_slide: i64,
    pub slide_statuses: Vec<String>,
    pub export_ready: bool,
    pub slide_notice: String,
    pub preference_snapshot: Vec<PreferenceSnapshot>,
    pub pipeline: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredCheckpoint {
    pub project_id: String,
    pub sequence: i64,
    pub workflow_status: String,
    pub selected_slide: i64,
    pub slide_statuses: Vec<String>,
    pub export_ready: bool,
    pub created_at: String,
    pub pipeline: serde_json::Value,
}

#[derive(Clone, Debug)]
pub struct NewMemoryProposal {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredMemoryProposal {
    pub id: String,
    pub title: String,
    pub content: String,
    pub status: String,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredApproval {
    pub id: String,
    pub project_id: String,
    pub version_id: String,
    pub stage: String,
    pub slide_id: Option<String>,
    pub status: String,
    pub title: String,
    pub detail: String,
    pub author: String,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistenceCounts {
    pub versions: i64,
    pub approvals: i64,
    pub tasks: i64,
    pub artifacts: i64,
}

#[derive(Clone, Debug)]
pub struct PersistedArtifact {
    pub id: String,
    pub version_id: String,
    pub path: String,
    pub kind: String,
    pub created_at: String,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path)?;
        let database = Self { connection };
        database.initialize_schema()?;
        Ok(database)
    }

    pub fn open_in_memory() -> Result<Self> {
        let connection = Connection::open_in_memory()?;
        let database = Self { connection };
        database.initialize_schema()?;
        Ok(database)
    }

    pub fn table_names(&self) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let result = statement.query_map([], |row| row.get(0))?.collect();
        result
    }

    pub fn save_setting(&self, key: &str, value: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>> {
        self.connection
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn insert_memory_proposal(&self, proposal: &NewMemoryProposal) -> Result<()> {
        self.connection.execute(
            "INSERT INTO memory_proposals
             (id, title, content, status, created_at, decided_at)
             VALUES (?1, ?2, ?3, 'proposed', ?4, NULL)",
            params![
                proposal.id,
                proposal.title,
                proposal.content,
                proposal.created_at
            ],
        )?;
        Ok(())
    }

    pub fn decide_memory(&self, id: &str, status: &str, decided_at: &str) -> Result<bool> {
        validate_decision(status, "memory")?;
        Ok(self.connection.execute(
            "UPDATE memory_proposals SET status = ?2, decided_at = ?3
             WHERE id = ?1 AND status = 'proposed'",
            params![id, status, decided_at],
        )? == 1)
    }

    pub fn list_memory_proposals(&self) -> Result<Vec<StoredMemoryProposal>> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, content, status, created_at, decided_at
             FROM memory_proposals ORDER BY created_at DESC, id DESC",
        )?;
        let result = statement
            .query_map([], |row| {
                Ok(StoredMemoryProposal {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    status: row.get(3)?,
                    created_at: row.get(4)?,
                    decided_at: row.get(5)?,
                })
            })?
            .collect();
        result
    }

    pub fn insert_project(&self, project: &NewProject) -> Result<()> {
        let preference_snapshot = self.approved_memory_snapshot()?;
        let preference_json = serde_json::to_string(&preference_snapshot)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let pipeline_json = initial_pipeline_json(project, &preference_snapshot)?;
        let slides_json = default_slides_json();
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO projects
             (id, name, goal, workflow_status, progress, selected_slide,
              slide_statuses_json, export_ready, slide_notice,
              preference_snapshot_json, pipeline_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'intake', 10, 1, ?4, 0,
                     '等待材料处理', ?5, ?6, ?7, ?7)",
            params![
                project.id,
                project.name,
                project.goal,
                slides_json,
                preference_json,
                pipeline_json,
                project.created_at
            ],
        )?;
        transaction.execute(
            "INSERT INTO checkpoints
             (project_id, sequence, workflow_status, selected_slide,
              slide_statuses_json, export_ready, created_at, pipeline_json)
             VALUES (?1, 1, 'intake', 1, ?2, 0, ?3, ?4)",
            params![project.id, slides_json, project.created_at, pipeline_json],
        )?;
        transaction.commit()
    }

    pub fn rename_project(&self, id: &str, name: &str, updated_at: &str) -> Result<bool> {
        let transaction = self.connection.unchecked_transaction()?;
        let encoded: Option<String> = transaction
            .query_row(
                "SELECT pipeline_json FROM projects WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(encoded) = encoded else {
            return Ok(false);
        };
        let mut pipeline: serde_json::Value = json_column(encoded, 0)?;
        let project = pipeline
            .get_mut("project")
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| invalid_parameter("pipeline project object is invalid"))?;
        project.insert("name".into(), name.into());
        project.insert("updatedAt".into(), updated_at.into());
        let encoded = serde_json::to_string(&pipeline)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        transaction.execute(
            "UPDATE projects SET name = ?2, updated_at = ?3, pipeline_json = ?4 WHERE id = ?1",
            params![id, name, updated_at, encoded],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn mutate_project(&self, id: &str, mutation: &ProjectMutation) -> Result<bool> {
        validate_slide_statuses(&mutation.slide_statuses)?;
        if !(0..=100).contains(&mutation.progress) || !(1..=5).contains(&mutation.selected_slide) {
            return Err(invalid_parameter(
                "project progress or selected slide is invalid",
            ));
        }
        let slides_json = serde_json::to_string(&mutation.slide_statuses)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let transaction = self.connection.unchecked_transaction()?;
        let changed = transaction.execute(
            "UPDATE projects SET workflow_status = ?2, progress = ?3,
             selected_slide = ?4, slide_statuses_json = ?5, export_ready = ?6,
             slide_notice = ?7, updated_at = ?8 WHERE id = ?1",
            params![
                id,
                mutation.workflow_status,
                mutation.progress,
                mutation.selected_slide,
                slides_json,
                mutation.export_ready,
                mutation.slide_notice,
                mutation.updated_at
            ],
        )?;
        if changed == 1 {
            transaction.execute(
                "INSERT INTO checkpoints
                 (project_id, sequence, workflow_status, selected_slide,
                  slide_statuses_json, export_ready, created_at)
                 SELECT ?1, COALESCE(MAX(sequence), 0) + 1, ?2, ?3, ?4, ?5, ?6
                 FROM checkpoints WHERE project_id = ?1",
                params![
                    id,
                    mutation.workflow_status,
                    mutation.selected_slide,
                    slides_json,
                    mutation.export_ready,
                    mutation.updated_at
                ],
            )?;
        }
        transaction.commit()?;
        Ok(changed == 1)
    }

    pub fn get_project(&self, id: &str) -> Result<Option<StoredProject>> {
        self.connection
            .query_row(
                "SELECT id, name, goal, workflow_status, progress, selected_slide,
                        slide_statuses_json, export_ready, slide_notice,
                        preference_snapshot_json, pipeline_json, created_at, updated_at
                 FROM projects WHERE id = ?1",
                params![id],
                row_to_project,
            )
            .optional()
    }

    pub fn list_projects(&self) -> Result<Vec<StoredProject>> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, goal, workflow_status, progress, selected_slide,
                    slide_statuses_json, export_ready, slide_notice,
                    preference_snapshot_json, pipeline_json, created_at, updated_at
             FROM projects ORDER BY updated_at DESC, id DESC",
        )?;
        let result = statement.query_map([], row_to_project)?.collect();
        result
    }

    pub fn latest_checkpoint(&self, project_id: &str) -> Result<Option<StoredCheckpoint>> {
        self.connection
            .query_row(
                "SELECT project_id, sequence, workflow_status, selected_slide,
                        slide_statuses_json, export_ready, created_at, pipeline_json
                 FROM checkpoints WHERE project_id = ?1
                 ORDER BY sequence DESC LIMIT 1",
                params![project_id],
                |row| {
                    Ok(StoredCheckpoint {
                        project_id: row.get(0)?,
                        sequence: row.get(1)?,
                        workflow_status: row.get(2)?,
                        selected_slide: row.get(3)?,
                        slide_statuses: json_column(row.get::<_, String>(4)?, 4)?,
                        export_ready: row.get(5)?,
                        created_at: row.get(6)?,
                        pipeline: json_column(row.get::<_, String>(7)?, 7)?,
                    })
                },
            )
            .optional()
    }

    pub fn replace_pipeline(
        &self,
        project_id: &str,
        expected_revision: i64,
        pipeline: &serde_json::Value,
        artifacts: &[PersistedArtifact],
    ) -> Result<bool> {
        let revision = json_i64(pipeline, "/revision")?;
        if revision != expected_revision + 1 {
            return Err(invalid_parameter(
                "pipeline revision must advance exactly once",
            ));
        }
        if json_str(pipeline, "/project/id")? != project_id {
            return Err(invalid_parameter("pipeline project id does not match"));
        }
        let current: Option<String> = self
            .connection
            .query_row(
                "SELECT pipeline_json FROM projects WHERE id = ?1",
                params![project_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(current) = current else {
            return Ok(false);
        };
        let current: serde_json::Value = serde_json::from_str(&current).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        if json_i64(&current, "/revision")? != expected_revision {
            return Err(invalid_parameter("stale pipeline revision"));
        }

        let workflow_status = json_str(pipeline, "/project/workflowStatus")?;
        let updated_at = json_str(pipeline, "/project/updatedAt")?;
        let selected_slide = selected_slide_number(pipeline);
        let slide_statuses = slide_statuses(pipeline);
        let progress = workflow_progress(workflow_status);
        let export_ready = pipeline
            .pointer("/exportReceipt")
            .is_some_and(|value| !value.is_null());
        let notice = pipeline
            .pointer("/blockedCondition/message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("PPT 工作流检查点已保存");
        let pipeline_json = serde_json::to_string(pipeline)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        let slides_json = serde_json::to_string(&slide_statuses)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;

        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "UPDATE projects SET workflow_status=?2, progress=?3, selected_slide=?4,
             slide_statuses_json=?5, export_ready=?6, slide_notice=?7, updated_at=?8,
             pipeline_json=?9 WHERE id=?1",
            params![
                project_id,
                workflow_status,
                progress,
                selected_slide,
                slides_json,
                export_ready,
                notice,
                updated_at,
                pipeline_json
            ],
        )?;
        for table in ["versions", "approvals", "tasks"] {
            transaction.execute(
                &format!("DELETE FROM {table} WHERE project_id = ?1"),
                params![project_id],
            )?;
        }
        let mut versions = Vec::new();
        if let Some(version) = pipeline.pointer("/outline/version") {
            versions.push(version);
        }
        if let Some(version) = pipeline.pointer("/slideSpecs/version") {
            versions.push(version);
        }
        if let Some(visuals) = pipeline
            .pointer("/visuals")
            .and_then(serde_json::Value::as_object)
        {
            for visual in visuals.values() {
                if let Some(history) = visual.as_array() {
                    versions.extend(history.iter().filter_map(|item| item.get("version")));
                } else if let Some(version) = visual.get("version") {
                    versions.push(version);
                }
            }
        }
        for (ordinal, version) in versions.into_iter().enumerate() {
            transaction.execute(
                "INSERT INTO versions (id, project_id, sequence, status, created_at, frozen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    json_str(version, "/id")?,
                    project_id,
                    ordinal as i64 + 1,
                    json_str(version, "/status")?,
                    json_str(version, "/createdAt")?,
                    version.get("frozenAt").and_then(serde_json::Value::as_str)
                ],
            )?;
        }
        if let Some(approvals) = pipeline
            .pointer("/approvals")
            .and_then(serde_json::Value::as_array)
        {
            for approval in approvals {
                let id = json_str(approval, "/id")?;
                let decided_at = approval
                    .get("decidedAt")
                    .and_then(serde_json::Value::as_str);
                transaction.execute(
                    "INSERT INTO approvals (id, project_id, version_id, stage, slide_id, status,
                     title, detail, author, created_at, decided_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'本机用户',?9,?10)",
                    params![
                        id,
                        project_id,
                        json_str(approval, "/versionId")?,
                        json_str(approval, "/stage")?,
                        approval.get("slideId").and_then(serde_json::Value::as_str),
                        json_str(approval, "/status")?,
                        format!("工作流审批·{}", json_str(approval, "/stage")?),
                        format!(
                            "版本 {} 已经用户明确批准",
                            json_str(approval, "/versionId")?
                        ),
                        decided_at.unwrap_or(updated_at),
                        decided_at
                    ],
                )?;
            }
        }
        if let Some(tasks) = pipeline
            .pointer("/tasks")
            .and_then(serde_json::Value::as_array)
        {
            for task in tasks {
                transaction.execute(
                    "INSERT INTO tasks (id, project_id, status, created_at, updated_at) VALUES (?1,?2,?3,?4,?5)",
                    params![json_str(task, "/id")?, project_id, json_str(task, "/status")?,
                        json_str(task, "/createdAt")?, json_str(task, "/updatedAt")?],
                )?;
            }
        }
        for artifact in artifacts {
            transaction.execute(
                "INSERT OR REPLACE INTO artifacts (id, project_id, version_id, path, kind, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![artifact.id, project_id, artifact.version_id, artifact.path, artifact.kind, artifact.created_at],
            )?;
        }
        transaction.execute(
            "INSERT INTO checkpoints (project_id, sequence, workflow_status, selected_slide,
             slide_statuses_json, export_ready, created_at, pipeline_json)
             SELECT ?1, COALESCE(MAX(sequence),0)+1, ?2, ?3, ?4, ?5, ?6, ?7
             FROM checkpoints WHERE project_id=?1",
            params![
                project_id,
                workflow_status,
                selected_slide,
                slides_json,
                export_ready,
                updated_at,
                pipeline_json
            ],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn persistence_counts(&self, project_id: &str) -> Result<PersistenceCounts> {
        let count = |table: &str| {
            self.connection.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE project_id=?1"),
                params![project_id],
                |row| row.get(0),
            )
        };
        Ok(PersistenceCounts {
            versions: count("versions")?,
            approvals: count("approvals")?,
            tasks: count("tasks")?,
            artifacts: count("artifacts")?,
        })
    }

    pub fn insert_approval(&self, approval: &StoredApproval) -> Result<()> {
        self.connection.execute(
            "INSERT INTO approvals
             (id, project_id, version_id, stage, slide_id, status, title,
              detail, author, created_at, decided_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                approval.id,
                approval.project_id,
                approval.version_id,
                approval.stage,
                approval.slide_id,
                approval.status,
                approval.title,
                approval.detail,
                approval.author,
                approval.created_at,
                approval.decided_at
            ],
        )?;
        Ok(())
    }

    pub fn list_pending_approvals(&self) -> Result<Vec<StoredApproval>> {
        let mut statement = self.connection.prepare(
            "SELECT id, project_id, version_id, stage, slide_id, status,
                    title, detail, author, created_at, decided_at
             FROM approvals WHERE status = 'pending'
             ORDER BY created_at DESC, id DESC",
        )?;
        let result = statement
            .query_map([], |row| {
                Ok(StoredApproval {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    version_id: row.get(2)?,
                    stage: row.get(3)?,
                    slide_id: row.get(4)?,
                    status: row.get(5)?,
                    title: row.get(6)?,
                    detail: row.get(7)?,
                    author: row.get(8)?,
                    created_at: row.get(9)?,
                    decided_at: row.get(10)?,
                })
            })?
            .collect();
        result
    }

    pub fn decide_approval(&self, id: &str, status: &str, decided_at: &str) -> Result<bool> {
        validate_decision(status, "approval")?;
        Ok(self.connection.execute(
            "UPDATE approvals SET status = ?2, decided_at = ?3
             WHERE id = ?1 AND status = 'pending'",
            params![id, status, decided_at],
        )? == 1)
    }

    fn approved_memory_snapshot(&self) -> Result<Vec<PreferenceSnapshot>> {
        let mut statement = self.connection.prepare(
            "SELECT id, title, content, decided_at FROM memory_proposals
             WHERE status = 'approved' ORDER BY decided_at, id",
        )?;
        let result = statement
            .query_map([], |row| {
                Ok(PreferenceSnapshot {
                    proposal_id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    approved_at: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                })
            })?
            .collect();
        result
    }

    fn initialize_schema(&self) -> Result<()> {
        self.connection.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '',
                workflow_status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
                selected_slide INTEGER NOT NULL DEFAULT 1,
                slide_statuses_json TEXT NOT NULL DEFAULT '[\"waiting\",\"pending\",\"pending\",\"pending\",\"pending\"]',
                export_ready INTEGER NOT NULL DEFAULT 0, slide_notice TEXT NOT NULL DEFAULT '',
                preference_snapshot_json TEXT NOT NULL DEFAULT '[]',
                pipeline_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS versions (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                sequence INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
                frozen_at TEXT, UNIQUE(project_id, sequence)
            );
            CREATE TABLE IF NOT EXISTS approvals (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                version_id TEXT NOT NULL, stage TEXT NOT NULL, slide_id TEXT,
                status TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
                author TEXT NOT NULL DEFAULT '本机用户', created_at TEXT NOT NULL DEFAULT '', decided_at TEXT
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), status TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                version_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memory_proposals (
                id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
                status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT
            );
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS checkpoints (
                project_id TEXT NOT NULL REFERENCES projects(id), sequence INTEGER NOT NULL,
                workflow_status TEXT NOT NULL, selected_slide INTEGER NOT NULL,
                slide_statuses_json TEXT NOT NULL, export_ready INTEGER NOT NULL,
                created_at TEXT NOT NULL, pipeline_json TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY(project_id, sequence)
            );
            ",
        )?;

        for (table, column, definition) in [
            ("projects", "goal", "TEXT NOT NULL DEFAULT ''"),
            ("projects", "progress", "INTEGER NOT NULL DEFAULT 0"),
            ("projects", "selected_slide", "INTEGER NOT NULL DEFAULT 1"),
            ("projects", "slide_statuses_json", "TEXT NOT NULL DEFAULT '[\"waiting\",\"pending\",\"pending\",\"pending\",\"pending\"]'"),
            ("projects", "export_ready", "INTEGER NOT NULL DEFAULT 0"),
            ("projects", "slide_notice", "TEXT NOT NULL DEFAULT ''"),
            ("projects", "preference_snapshot_json", "TEXT NOT NULL DEFAULT '[]'"),
            ("projects", "pipeline_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("approvals", "slide_id", "TEXT"),
            ("approvals", "title", "TEXT NOT NULL DEFAULT ''"),
            ("approvals", "detail", "TEXT NOT NULL DEFAULT ''"),
            ("approvals", "author", "TEXT NOT NULL DEFAULT '本机用户'"),
            ("approvals", "created_at", "TEXT NOT NULL DEFAULT ''"),
            ("memory_proposals", "title", "TEXT NOT NULL DEFAULT ''"),
            ("checkpoints", "pipeline_json", "TEXT NOT NULL DEFAULT '{}'"),
        ] {
            self.ensure_column(table, column, definition)?;
        }
        Ok(())
    }

    fn ensure_column(&self, table: &str, column: &str, definition: &str) -> Result<()> {
        let mut statement = self
            .connection
            .prepare(&format!("PRAGMA table_info({table})"))?;
        let columns: Vec<String> = statement
            .query_map([], |row| row.get(1))?
            .collect::<Result<Vec<_>>>()?;
        if !columns.iter().any(|candidate| candidate == column) {
            self.connection.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))?;
        }
        Ok(())
    }
}

fn row_to_project(row: &rusqlite::Row<'_>) -> Result<StoredProject> {
    Ok(StoredProject {
        id: row.get(0)?,
        name: row.get(1)?,
        goal: row.get(2)?,
        workflow_status: row.get(3)?,
        progress: row.get(4)?,
        selected_slide: row.get(5)?,
        slide_statuses: json_column(row.get::<_, String>(6)?, 6)?,
        export_ready: row.get(7)?,
        slide_notice: row.get(8)?,
        preference_snapshot: json_column(row.get::<_, String>(9)?, 9)?,
        pipeline: json_column(row.get::<_, String>(10)?, 10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

fn initial_pipeline_json(
    project: &NewProject,
    preferences: &[PreferenceSnapshot],
) -> Result<String> {
    serde_json::to_string(&serde_json::json!({
        "schemaVersion": 1,
        "revision": 1,
        "project": {
            "id": project.id,
            "name": project.name,
            "goal": project.goal,
            "workflowStatus": "intake",
            "createdAt": project.created_at,
            "updatedAt": project.created_at,
        },
        "preferenceSnapshot": preferences,
        "sources": [],
        "analysis": null,
        "outline": null,
        "slideSpecs": null,
        "visuals": {},
        "currentSlideId": null,
        "approvals": [],
        "tasks": [],
        "blockedCondition": null,
        "exportReceipt": null,
        "qaReport": null,
    }))
    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn json_str<'a>(value: &'a serde_json::Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| invalid_parameter(&format!("pipeline field {pointer} is required")))
}

fn json_i64(value: &serde_json::Value, pointer: &str) -> Result<i64> {
    value
        .pointer(pointer)
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| invalid_parameter(&format!("pipeline field {pointer} is required")))
}

fn selected_slide_number(pipeline: &serde_json::Value) -> i64 {
    let Some(id) = pipeline
        .pointer("/currentSlideId")
        .and_then(serde_json::Value::as_str)
    else {
        return 1;
    };
    pipeline
        .pointer("/slideSpecs/value")
        .and_then(serde_json::Value::as_array)
        .and_then(|specs| {
            specs
                .iter()
                .position(|spec| spec.get("id").and_then(serde_json::Value::as_str) == Some(id))
        })
        .map(|index| index as i64 + 1)
        .unwrap_or(1)
}

fn slide_statuses(pipeline: &serde_json::Value) -> Vec<String> {
    let specs = pipeline
        .pointer("/slideSpecs/value")
        .and_then(serde_json::Value::as_array);
    let visuals = pipeline
        .pointer("/visuals")
        .and_then(serde_json::Value::as_object);
    let current = pipeline
        .pointer("/currentSlideId")
        .and_then(serde_json::Value::as_str);
    let mut statuses: Vec<String> = specs
        .into_iter()
        .flatten()
        .map(|spec| {
            let id = spec
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let visual = visuals.and_then(|items| items.get(id));
            let version = visual
                .and_then(|item| {
                    item.as_array()
                        .and_then(|items| items.last())
                        .or(Some(item))
                })
                .and_then(|item| item.get("version"));
            if version
                .and_then(|item| item.get("status"))
                .and_then(serde_json::Value::as_str)
                == Some("frozen")
            {
                "approved".to_string()
            } else if current == Some(id) {
                "waiting".to_string()
            } else {
                "pending".to_string()
            }
        })
        .collect();
    while statuses.len() < 5 {
        statuses.push("pending".to_string());
    }
    statuses.truncate(5);
    if statuses.iter().all(|status| status == "pending") {
        statuses[0] = "waiting".to_string();
    }
    statuses
}

fn workflow_progress(status: &str) -> i64 {
    match status {
        "intake" => 10,
        "source_analysis" => 25,
        "outline_review" => 35,
        "detail_review" => 45,
        "visual_review" | "blocked" => 60,
        "conversion" => 78,
        "qa" => 90,
        "completed" => 100,
        _ => 0,
    }
}

fn json_column<T: serde::de::DeserializeOwned>(value: String, index: usize) -> Result<T> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn default_slides_json() -> String {
    serde_json::to_string(&vec!["waiting", "pending", "pending", "pending", "pending"])
        .expect("static slide statuses serialize")
}

fn validate_slide_statuses(statuses: &[String]) -> Result<()> {
    if statuses.len() != 5
        || !statuses
            .iter()
            .all(|status| matches!(status.as_str(), "approved" | "waiting" | "pending"))
    {
        return Err(invalid_parameter(
            "project must contain five valid slide statuses",
        ));
    }
    Ok(())
}

fn validate_decision(status: &str, kind: &str) -> Result<()> {
    if !matches!(status, "approved" | "rejected") {
        return Err(invalid_parameter(&format!(
            "{kind} decision must be approved or rejected"
        )));
    }
    Ok(())
}

fn invalid_parameter(message: &str) -> rusqlite::Error {
    rusqlite::Error::InvalidParameterName(message.into())
}
