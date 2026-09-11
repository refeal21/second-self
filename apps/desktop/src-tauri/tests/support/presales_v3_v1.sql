CREATE TABLE queue_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    concurrency INTEGER NOT NULL CHECK (concurrency BETWEEN 1 AND 4),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    epoch INTEGER NOT NULL
);

CREATE TABLE queue_batches (
    batch_id TEXT PRIMARY KEY,
    input_json TEXT NOT NULL,
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE queue_jobs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES queue_batches(batch_id),
    request_id TEXT NOT NULL UNIQUE,
    attempt_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    target_json TEXT NOT NULL,
    status TEXT NOT NULL,
    epoch INTEGER,
    provider_json TEXT,
    result_json TEXT,
    error TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    dispatched_at_ms INTEGER
);

CREATE UNIQUE INDEX queue_jobs_active_page
ON queue_jobs(project_id, slide_id)
WHERE status IN (
    'queued', 'dispatching', 'running', 'result_ready', 'committing',
    'cancel_requested', 'outcome_unknown'
);

CREATE TABLE queue_attempts (
    attempt_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE REFERENCES queue_jobs(request_id),
    target_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE queue_batch_entries (
    batch_id TEXT NOT NULL REFERENCES queue_batches(batch_id),
    ordinal INTEGER NOT NULL,
    submitted_request_id TEXT NOT NULL UNIQUE,
    submitted_attempt_id TEXT NOT NULL UNIQUE,
    resolved_request_id TEXT NOT NULL REFERENCES queue_jobs(request_id),
    reused INTEGER NOT NULL CHECK (reused IN (0, 1)),
    PRIMARY KEY (batch_id, ordinal)
);

CREATE TABLE queue_transition_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES queue_jobs(request_id),
    from_status TEXT,
    to_status TEXT NOT NULL,
    epoch INTEGER,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE queue_lifecycle_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL REFERENCES queue_jobs(request_id),
    attempt_id TEXT NOT NULL REFERENCES queue_attempts(attempt_id),
    kind TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE TABLE v3_legacy_activity (
    evidence_id TEXT NOT NULL PRIMARY KEY,
    evidence_json TEXT NOT NULL
);

CREATE TABLE v3_projects (
    project_id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    frozen_json TEXT NOT NULL,
    origin_json TEXT NOT NULL,
    palette_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1)
);

CREATE TABLE v3_pages (
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
);

CREATE TABLE v3_admissions (
    batch_id TEXT NOT NULL PRIMARY KEY REFERENCES queue_batches(batch_id),
    input_json TEXT NOT NULL
);

CREATE TABLE v3_intents (
    request_id TEXT NOT NULL PRIMARY KEY REFERENCES queue_jobs(request_id),
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    page_revision INTEGER NOT NULL CHECK (page_revision >= 1),
    target_json TEXT NOT NULL,
    FOREIGN KEY (project_id, slide_id) REFERENCES v3_pages(project_id, slide_id)
);

CREATE TABLE v3_versions (
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
);

CREATE TABLE v3_receipts (
    request_id TEXT NOT NULL PRIMARY KEY REFERENCES queue_jobs(request_id),
    attempt_id TEXT NOT NULL UNIQUE REFERENCES queue_attempts(attempt_id),
    version_id TEXT NOT NULL UNIQUE REFERENCES v3_versions(version_id),
    receipt_json TEXT NOT NULL
);

CREATE TABLE v3_approvals (
    approval_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    approval_json TEXT NOT NULL,
    FOREIGN KEY (project_id, slide_id, version_id) REFERENCES v3_versions(project_id, slide_id, version_id),
    UNIQUE (project_id, slide_id, version_id)
);

CREATE TABLE v3_feedback (
    project_id TEXT NOT NULL,
    slide_id TEXT NOT NULL,
    base_version_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    draft_json TEXT NOT NULL,
    PRIMARY KEY (project_id, slide_id, base_version_id),
    FOREIGN KEY (project_id, slide_id) REFERENCES v3_pages(project_id, slide_id)
);

CREATE TABLE v3_import_receipts (
    import_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES v3_projects(project_id),
    origin_digest TEXT NOT NULL,
    receipt_json TEXT NOT NULL
);

CREATE TABLE v3_delivery_snapshots (
    snapshot_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES v3_projects(project_id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    snapshot_json TEXT NOT NULL,
    UNIQUE (project_id, revision)
);

CREATE TABLE v3_artifacts (
    artifact_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES v3_projects(project_id),
    version_id TEXT REFERENCES v3_versions(version_id),
    relative_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    metadata_json TEXT NOT NULL
);

INSERT INTO queue_settings VALUES (1,4,0,0);
PRAGMA application_id=1146377779;
PRAGMA user_version=1;

