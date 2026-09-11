//! Exact immediate-pre-import V3 schema. Recognized only for the one v1 → v2 upgrade.
use super::SchemaObject;

pub(super) const OBJECTS: [SchemaObject; 12] = [
    SchemaObject {
        kind: "table",
        name: "v3_legacy_activity",
        sql: r#"CREATE TABLE v3_legacy_activity (
    evidence_id TEXT NOT NULL PRIMARY KEY,
    evidence_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_projects",
        sql: r#"CREATE TABLE v3_projects (
    project_id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    frozen_json TEXT NOT NULL,
    origin_json TEXT NOT NULL,
    palette_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_pages",
        sql: r#"CREATE TABLE v3_pages (
    project_id TEXT NOT NULL REFERENCES v3_projects(project_id),
    slide_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    spec_json TEXT NOT NULL,
    design_json TEXT,
    basis_json TEXT,
    current_version_id TEXT,
    approved_version_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    intent_request_id TEXT REFERENCES queue_jobs(request_id),
    PRIMARY KEY (project_id, slide_id),
    UNIQUE (project_id, ordinal),
    FOREIGN KEY (project_id, slide_id, current_version_id) REFERENCES v3_versions(project_id, slide_id, version_id),
    FOREIGN KEY (project_id, slide_id, approved_version_id) REFERENCES v3_versions(project_id, slide_id, version_id)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_admissions",
        sql: r#"CREATE TABLE v3_admissions (
    batch_id TEXT NOT NULL PRIMARY KEY REFERENCES queue_batches(batch_id),
    input_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_intents",
        sql: r#"CREATE TABLE v3_intents (
    request_id TEXT NOT NULL PRIMARY KEY REFERENCES queue_jobs(request_id),
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    page_revision INTEGER NOT NULL CHECK (page_revision >= 1),
    target_json TEXT NOT NULL,
    FOREIGN KEY (project_id, slide_id) REFERENCES v3_pages(project_id, slide_id)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_versions",
        sql: r#"CREATE TABLE v3_versions (
    version_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    request_id TEXT UNIQUE REFERENCES queue_jobs(request_id),
    attempt_id TEXT UNIQUE REFERENCES queue_attempts(attempt_id),
    status TEXT NOT NULL,
    version_json TEXT NOT NULL,
    FOREIGN KEY (project_id, slide_id) REFERENCES v3_pages(project_id, slide_id),
    UNIQUE (project_id, slide_id, sequence),
    UNIQUE (project_id, slide_id, version_id),
    CHECK ((request_id IS NULL) = (attempt_id IS NULL))
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_receipts",
        sql: r#"CREATE TABLE v3_receipts (
    request_id TEXT NOT NULL PRIMARY KEY REFERENCES queue_jobs(request_id),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES queue_attempts(attempt_id),
    version_id TEXT NOT NULL UNIQUE REFERENCES v3_versions(version_id),
    receipt_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_approvals",
        sql: r#"CREATE TABLE v3_approvals (
    approval_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    approval_json TEXT NOT NULL,
    FOREIGN KEY (project_id, slide_id, version_id) REFERENCES v3_versions(project_id, slide_id, version_id),
    UNIQUE (project_id, slide_id, version_id)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_feedback",
        sql: r#"CREATE TABLE v3_feedback (
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    base_version_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    draft_json TEXT NOT NULL,
    PRIMARY KEY (project_id, slide_id, base_version_id),
    FOREIGN KEY (project_id, slide_id) REFERENCES v3_pages(project_id, slide_id)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_import_receipts",
        sql: r#"CREATE TABLE v3_import_receipts (
    import_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES v3_projects(project_id),
    origin_digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_delivery_snapshots",
        sql: r#"CREATE TABLE v3_delivery_snapshots (
    snapshot_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES v3_projects(project_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    snapshot_json TEXT NOT NULL,
    UNIQUE (project_id, revision)
)"#,
    },
    SchemaObject {
        kind: "table",
        name: "v3_artifacts",
        sql: r#"CREATE TABLE v3_artifacts (
    artifact_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES v3_projects(project_id),
    version_id TEXT REFERENCES v3_versions(version_id),
    relative_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    metadata_json TEXT NOT NULL
)"#,
    },
];
