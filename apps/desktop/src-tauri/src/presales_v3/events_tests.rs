use super::*;
use crate::presales_queue::{JobStatus, ResultVault};
use rusqlite::params;

#[path = "../../tests/support/v3_temp.rs"]
mod tempfile;
#[path = "../../tests/support/v3_v1_fixture.rs"]
mod v1_fixture;

#[test]
fn exact_schema_upgrade_preserves_native_queue_history_approvals_and_delivery() {
    let (mut store, directory, vault) = fixture();
    for n in 1..=3 {
        let request = format!("migration-{n}");
        store
            .enqueue_pages(input(&store, n, &request), None)
            .unwrap();
        let completion = ready(&mut store, &vault, &request);
        store.commit_result(completion, &vault).unwrap();
        approve(&mut store, &vault, n);
    }
    store
        .create_delivery_snapshot("frozen-project", &vault)
        .unwrap();
    let before = store.load_project("frozen-project").unwrap();
    let v2 = directory.path().join("catalog.sqlite3");
    let v1 = directory.path().join("legacy-v3.sqlite3");
    drop(store);
    v1_fixture::copy_existing_rows_into_v1(&v2, &v1);
    let original = rusqlite::Connection::open(&v1).unwrap();
    original
        .execute("UPDATE v3_projects SET rowid=rowid+40", [])
        .unwrap();
    original
        .execute("UPDATE v3_pages SET rowid=rowid+100", [])
        .unwrap();
    let rows = |db: &rusqlite::Connection| {
        [
            "v3_projects",
            "v3_pages",
            "v3_versions",
            "v3_approvals",
            "v3_artifacts",
            "v3_receipts",
            "v3_delivery_snapshots",
            "v3_intents",
            "queue_jobs",
            "queue_attempts",
            "queue_lifecycle_events",
        ]
        .into_iter()
        .map(|table| {
            let mut statement = db
                .prepare(&format!("SELECT rowid,* FROM {table} ORDER BY rowid"))
                .unwrap();
            let count = statement.column_count();
            statement
                .query_map([], |r| {
                    (0..count)
                        .map(|i| r.get::<_, rusqlite::types::Value>(i))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        })
        .collect::<Vec<_>>()
    };
    let original_rows = rows(&original);
    drop(original);
    let upgraded = V3Store::open(&v1).unwrap();
    assert_eq!(upgraded.load_project("frozen-project").unwrap(), before);
    assert_eq!(rows(&upgraded.connection), original_rows);
    assert_eq!(
        upgraded
            .connection
            .pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        upgraded
            .connection
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn injected_upgrade_failures_roll_back_schema_rows_and_version_before_reopen() {
    let (store, directory, _vault) = fixture();
    let expected = store.load_project("frozen-project").unwrap();
    drop(store);
    for stage in ["after_catalog_ddl", "after_row_copy", "before_commit"] {
        let old = directory.path().join(format!("{stage}.sqlite3"));
        v1_fixture::copy_existing_rows_into_v1(&directory.path().join("catalog.sqlite3"), &old);
        let original_bytes = std::fs::read(&old).unwrap();
        crate::presales_queue::schema::inject_v3_upgrade_failure(Some(stage));
        let error = V3Store::open(&old).err().unwrap();
        crate::presales_queue::schema::inject_v3_upgrade_failure(None);
        assert!(error.contains(stage));
        assert_eq!(std::fs::read(&old).unwrap(), original_bytes, "{stage}");
        let db = rusqlite::Connection::open(&old).unwrap();
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM sqlite_schema WHERE name='v3_catalog'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        drop(db);
        let upgraded = V3Store::open(&old).unwrap();
        assert_eq!(upgraded.load_project("frozen-project").unwrap(), expected);
    }
}

fn fixture() -> (V3Store, tempfile::TempDir, ResultVault) {
    let (checkpoint, palette) = super::basis::tests::frozen_fixture_pages(3);
    let dir = tempfile::tempdir().unwrap();
    let mut store = V3Store::open(dir.path().join("catalog.sqlite3")).unwrap();
    store
        .insert_project(ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette).unwrap())
        .unwrap();
    let vault = ResultVault::open(dir.path()).unwrap();
    (store, dir, vault)
}
fn page(store: &V3Store, n: usize) -> V3PageState {
    store.load_project("frozen-project").unwrap().pages[n - 1].clone()
}
fn input(store: &V3Store, n: usize, request: &str) -> EnqueuePages {
    EnqueuePages {
        project_id: "frozen-project".into(),
        batch_id: format!("batch-{request}"),
        pages: vec![PageRequest {
            slide_id: format!("scenario-{n}"),
            request_id: request.into(),
            attempt_id: format!("attempt-{request}"),
            expected_revision: page(store, n).revision,
            parent_version_id: None,
            feedback: "more space".into(),
        }],
    }
}
pub(super) fn ready(store: &mut V3Store, vault: &ResultVault, request: &str) -> CommitResult {
    // Synthetic provider completion: no login, external call, or generated customer file.
    let tx = store.connection.transaction().unwrap();
    loop {
        let current = crate::presales_queue::store::read_job(&tx, request)
            .unwrap()
            .unwrap();
        if current.status != JobStatus::Queued {
            break;
        }
        crate::presales_queue::store::claim_next_on(&tx, 0)
            .unwrap()
            .unwrap();
    }
    tx.commit().unwrap();
    let job = crate::presales_queue::store::read_job(&store.connection, request)
        .unwrap()
        .unwrap();
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, 640, 360);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&vec![42; 640 * 360 * 3]).unwrap();
    }
    let verified = vault
        .stage(
            &crate::presales_queue::result_staging::result_binding(&job).unwrap(),
            &png,
        )
        .unwrap();
    let tx = store.connection.transaction().unwrap();
    let job = crate::presales_queue::store::read_job(&tx, request)
        .unwrap()
        .unwrap();
    crate::presales_queue::lifecycle::record_result_evidence(
        &tx,
        job.clone(),
        verified.manifest().clone(),
    )
    .unwrap();
    tx.commit().unwrap();
    CommitResult {
        epoch: 0,
        request_id: request.into(),
        attempt_id: job.attempt_id,
    }
}
fn approve(store: &mut V3Store, vault: &ResultVault, n: usize) -> V3Approval {
    let p = page(store, n);
    let v = p
        .versions
        .iter()
        .find(|v| Some(&v.version_id) == p.current_version_id.as_ref())
        .unwrap();
    store
        .approve_version(
            ApproveVersion {
                project_id: "frozen-project".into(),
                slide_id: p.slide_id,
                version_id: v.version_id.clone(),
                image_sha256: v.image.as_ref().unwrap().sha256.clone(),
                basis: v.basis.clone().unwrap(),
                expected_revision: p.revision,
                content_checked: true,
                visual_checked: true,
            },
            vault,
        )
        .unwrap()
}

#[test]
fn interleaved_publication_preserves_other_page_approval_and_exact_receipts() {
    let (mut store, _dir, vault) = fixture();
    for n in 1..=3 {
        let i = input(&store, n, &format!("r{n}"));
        store.enqueue_pages(i, None).unwrap();
    }
    let b = ready(&mut store, &vault, "r2");
    store.commit_result(b, &vault).unwrap();
    let approved = approve(&mut store, &vault, 2);
    let a = ready(&mut store, &vault, "r1");
    let receipt = store.commit_result(a.clone(), &vault).unwrap();
    assert_eq!(store.commit_result(a, &vault).unwrap(), receipt);
    assert_eq!(page(&store, 2).approval, Some(approved.clone()));
    assert_eq!(page(&store, 1).versions.len(), 1);
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM v3_receipts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    let c = ready(&mut store, &vault, "r3");
    store.commit_result(c, &vault).unwrap();
    assert_eq!(page(&store, 2).approval, Some(approved));
    assert_eq!(page(&store, 3).versions.len(), 1);
}

#[test]
fn exact_admission_replay_does_not_reverify_historical_parent_bytes() {
    let (mut store, dir, vault) = fixture();
    let initial = input(&store, 1, "r1");
    store.enqueue_pages(initial, None).unwrap();
    let c = ready(&mut store, &vault, "r1");
    store.commit_result(c, &vault).unwrap();
    let mut next = input(&store, 1, "r2");
    next.pages[0].parent_version_id = page(&store, 1).current_version_id;
    let admitted = store.enqueue_pages(next.clone(), Some(&vault)).unwrap();
    assert_eq!(
        admitted.jobs[0].target.parent_visual.as_ref(),
        page(&store, 1).versions[0].image.as_ref()
    );
    std::fs::remove_file(dir.path().join("queue-results/r1/attempt-r1.png")).unwrap();
    assert_eq!(store.enqueue_pages(next, None).unwrap(), admitted);
}

#[test]
fn competing_parent_intent_is_ignored_without_vault_or_parent_bytes_including_mixed_batch() {
    for missing_parent_bytes in [false, true] {
        let (mut store, dir, vault) = fixture();
        let initial = input(&store, 1, "initial");
        store.enqueue_pages(initial, None).unwrap();
        let completion = ready(&mut store, &vault, "initial");
        store.commit_result(completion, &vault).unwrap();
        let parent = page(&store, 1).current_version_id;
        let revision = input(&store, 1, "revision");
        let admitted = store.enqueue_pages(revision, None).unwrap();
        let original_page = page(&store, 1);
        if missing_parent_bytes {
            std::fs::remove_file(dir.path().join("queue-results/initial/attempt-initial.png"))
                .unwrap();
        }
        let optional_vault = missing_parent_bytes.then_some(&vault);
        let mut competing = input(&store, 1, "competing");
        competing.pages[0].parent_version_id = parent.clone();
        competing.pages[0].feedback = "unused replacement feedback".into();
        let reused = store.enqueue_pages(competing, optional_vault).unwrap();
        assert_eq!(reused.jobs, admitted.jobs);
        assert_eq!(reused.reused_request_ids, vec!["revision"]);
        assert_eq!(page(&store, 1), original_page);

        let mut mixed = input(&store, 1, "competing-mixed");
        mixed.pages[0].parent_version_id = parent;
        mixed.pages[0].feedback = "also unused replacement feedback".into();
        mixed
            .pages
            .push(input(&store, 2, "new-page").pages.remove(0));
        let mixed_outcome = store.enqueue_pages(mixed, optional_vault).unwrap();
        assert_eq!(mixed_outcome.jobs[0], admitted.jobs[0]);
        assert_eq!(mixed_outcome.jobs[1].request_id, "new-page");
        assert_eq!(mixed_outcome.reused_request_ids, vec!["revision"]);
        assert_eq!(page(&store, 1), original_page);
        assert_eq!(page(&store, 2).revision, 2);
        assert_eq!(
            page(&store, 2).intent_request_id.as_deref(),
            Some("new-page")
        );
        assert!(
            crate::presales_queue::store::read_job(&store.connection, "competing")
                .unwrap()
                .is_none()
        );
        assert!(
            crate::presales_queue::store::read_job(&store.connection, "competing-mixed")
                .unwrap()
                .is_none()
        );
    }
}

#[test]
fn saturated_project_revision_rolls_back_admission_atomically() {
    let (mut store, _dir, _vault) = fixture();
    store
        .connection
        .execute("UPDATE v3_projects SET revision=?1", [i64::MAX])
        .unwrap();
    store
        .connection
        .execute("UPDATE v3_catalog SET revision=?1", [i64::MAX])
        .unwrap();
    let i = input(&store, 1, "r1");
    assert!(store.enqueue_pages(i, None).is_err());
    assert!(
        crate::presales_queue::store::read_job(&store.connection, "r1")
            .unwrap()
            .is_none()
    );
    assert_eq!(page(&store, 1).revision, 1);
}

#[test]
fn approval_rejects_false_checks_stale_revision_wrong_hash_and_unfinished_page() {
    let (mut store, _dir, vault) = fixture();
    let i = input(&store, 1, "r1");
    store.enqueue_pages(i, None).unwrap();
    let c = ready(&mut store, &vault, "r1");
    store.commit_result(c, &vault).unwrap();
    let p = page(&store, 1);
    let base = ApproveVersion {
        project_id: "frozen-project".into(),
        slide_id: p.slide_id.clone(),
        version_id: p.current_version_id.clone().unwrap(),
        image_sha256: p.versions[0].image.as_ref().unwrap().sha256.clone(),
        basis: p.visual_basis.clone().unwrap(),
        expected_revision: p.revision,
        content_checked: true,
        visual_checked: true,
    };
    for bad in [
        ApproveVersion {
            content_checked: false,
            ..base.clone()
        },
        ApproveVersion {
            visual_checked: false,
            ..base.clone()
        },
        ApproveVersion {
            expected_revision: 1,
            ..base.clone()
        },
        ApproveVersion {
            image_sha256: "0".repeat(64),
            ..base.clone()
        },
    ] {
        assert!(store.approve_version(bad, &vault).is_err());
    }
    assert!(page(&store, 1).approvals.is_empty());
    let i = input(&store, 1, "r2");
    store.enqueue_pages(i, None).unwrap();
    assert!(store
        .approve_version(
            ApproveVersion {
                expected_revision: page(&store, 1).revision,
                ..base
            },
            &vault
        )
        .is_err());
    assert!(store
        .adopt_version(
            AdoptVersion {
                project_id: "frozen-project".into(),
                slide_id: p.slide_id,
                version_id: p.current_version_id.unwrap(),
                expected_revision: page(&store, 1).revision
            },
            &vault
        )
        .is_err());
}

#[test]
fn loaded_mutable_history_rejects_row_and_json_identity_drift() {
    for mutation in [
        "UPDATE v3_versions SET version_json=json_set(version_json,'$.attemptId','forged')",
        "UPDATE v3_receipts SET receipt_json=json_set(receipt_json,'$.targetSha256','forged')",
        "UPDATE v3_receipts SET receipt_json=json_set(receipt_json,'$.pageRevision',4)",
        "DELETE FROM queue_lifecycle_events WHERE kind='published'",
        "UPDATE v3_artifacts SET relative_path='queue-results/other/other.png'",
        "UPDATE v3_approvals SET approval_json=json_set(approval_json,'$.imageSha256','forged')",
        "UPDATE v3_feedback SET draft_json=json_set(draft_json,'$.baseVersionId','forged')",
    ] {
        let (mut store, _dir, vault) = fixture();
        let i = input(&store, 1, "r1");
        store.enqueue_pages(i, None).unwrap();
        let c = ready(&mut store, &vault, "r1");
        store.commit_result(c, &vault).unwrap();
        approve(&mut store, &vault, 1);
        store
            .save_feedback(SaveFeedback {
                project_id: "frozen-project".into(),
                slide_id: "scenario-1".into(),
                base_version_id: page(&store, 1).current_version_id,
                expected_revision: 0,
                text: "draft".into(),
            })
            .unwrap();
        store.connection.execute(mutation, []).unwrap();
        assert!(store.load_project("frozen-project").is_err(), "{mutation}");
    }
}

#[test]
fn admission_replay_and_same_page_duplicate_preserve_original_feedback_and_intent() {
    let (mut store, _dir, _vault) = fixture();
    let original = input(&store, 1, "r1");
    let first = store.enqueue_pages(original.clone(), None).unwrap();
    let state = page(&store, 1);
    assert_eq!(store.enqueue_pages(original, None).unwrap(), first);
    let mut duplicate = input(&store, 1, "r2");
    duplicate.pages[0].feedback = "different".into();
    let outcome = store.enqueue_pages(duplicate, None).unwrap();
    assert_eq!(outcome.jobs[0].request_id, "r1");
    assert_eq!(outcome.jobs[0].target.feedback, "more space");
    assert_eq!(page(&store, 1), state);
}

#[test]
fn corrupt_or_missing_png_and_stale_intent_never_publish() {
    for fault in [
        "missing", "corrupt", "intent", "basis", "cancel", "abandon", "epoch",
    ] {
        let (mut store, dir, vault) = fixture();
        let i = input(&store, 1, "r1");
        store.enqueue_pages(i, None).unwrap();
        let commit = ready(&mut store, &vault, "r1");
        match fault {
            "missing" => {
                std::fs::remove_file(dir.path().join("queue-results/r1/attempt-r1.png")).unwrap()
            }
            "corrupt" => {
                std::fs::write(dir.path().join("queue-results/r1/attempt-r1.png"), b"bad").unwrap()
            }
            "intent" => {
                store
                    .connection
                    .execute("UPDATE v3_pages SET intent_request_id=NULL", [])
                    .unwrap();
            }
            "basis" => {
                store
                    .connection
                    .execute("UPDATE v3_pages SET basis_json='{}'", [])
                    .unwrap();
            }
            "cancel" => {
                store.connection.execute("INSERT INTO queue_lifecycle_events (request_id,attempt_id,kind,detail_json,created_at_ms) VALUES ('r1','attempt-r1','cancel_requested','{}',0)", []).unwrap();
            }
            "abandon" => {
                store
                    .connection
                    .execute("UPDATE queue_jobs SET status='abandoned_unresolved'", [])
                    .unwrap();
            }
            "epoch" => {
                store
                    .connection
                    .execute("UPDATE queue_settings SET epoch=1", [])
                    .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(store.commit_result(commit, &vault).is_err(), "{fault}");
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM v3_versions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0,
            "{fault}"
        );
        assert_ne!(
            crate::presales_queue::store::read_job(&store.connection, "r1")
                .unwrap()
                .unwrap()
                .status,
            JobStatus::Succeeded
        );
    }
}

#[test]
fn draft_cas_does_not_stale_generation_and_history_adoption_restoration_are_explicit() {
    let (mut store, _dir, vault) = fixture();
    for revision in 1..=5 {
        let request = format!("r{revision}");
        let i = input(&store, 1, &request);
        store.enqueue_pages(i, None).unwrap();
        let before = page(&store, 1);
        let draft = SaveFeedback {
            project_id: "frozen-project".into(),
            slide_id: "scenario-1".into(),
            base_version_id: before.current_version_id.clone(),
            expected_revision: 0,
            text: request.clone(),
        };
        store.save_feedback(draft.clone()).unwrap();
        assert!(store.save_feedback(draft).is_err());
        assert_eq!(page(&store, 1).revision, before.revision);
        let c = ready(&mut store, &vault, &request);
        store.commit_result(c, &vault).unwrap();
        approve(&mut store, &vault, 1);
    }
    let p = page(&store, 1);
    assert_eq!(p.versions.len(), 5);
    assert_eq!(p.approvals.len(), 5);
    assert_eq!(p.feedback_drafts.len(), 5);
    assert_eq!(page(&store, 1), p, "inspection is read-only");
    let choice = AdoptVersion {
        project_id: "frozen-project".into(),
        slide_id: "scenario-1".into(),
        version_id: p.versions[0].version_id.clone(),
        expected_revision: p.revision,
    };
    store.adopt_version(choice.clone(), &vault).unwrap();
    assert!(page(&store, 1).approval.is_none());
    store
        .restore_approval(
            AdoptVersion {
                expected_revision: page(&store, 1).revision,
                ..choice
            },
            &vault,
        )
        .unwrap();
    assert_eq!(
        page(&store, 1).approval.unwrap().version_id,
        p.versions[0].version_id
    );
}

#[test]
fn delivery_requires_exact_active_approvals_and_invalidates_on_new_admission() {
    let (mut store, _dir, vault) = fixture();
    assert!(store
        .create_delivery_snapshot("frozen-project", &vault)
        .is_err());
    for n in 1..=3 {
        let r = format!("r{n}");
        let i = input(&store, n, &r);
        store.enqueue_pages(i, None).unwrap();
        let c = ready(&mut store, &vault, &r);
        store.commit_result(c, &vault).unwrap();
        approve(&mut store, &vault, n);
    }
    let snapshot = store
        .create_delivery_snapshot("frozen-project", &vault)
        .unwrap();
    assert_eq!(snapshot.pages.len(), 3);
    assert_eq!(
        store
            .create_delivery_snapshot("frozen-project", &vault)
            .unwrap(),
        snapshot
    );
    let i = input(&store, 1, "new");
    store.enqueue_pages(i, None).unwrap();
    assert!(store
        .load_project("frozen-project")
        .unwrap()
        .delivery_snapshot
        .is_none());
    assert!(store
        .create_delivery_snapshot("frozen-project", &vault)
        .is_err());
    assert_eq!(
        store
            .connection
            .query_row("SELECT COUNT(*) FROM v3_delivery_snapshots", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn failed_local_commit_retains_ready_bytes_for_save_only_retry() {
    let (mut store, _dir, vault) = fixture();
    let i = input(&store, 1, "r1");
    store.enqueue_pages(i, None).unwrap();
    let c = ready(&mut store, &vault, "r1");
    store.connection.execute_batch("CREATE TRIGGER fail_receipt BEFORE INSERT ON v3_receipts BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END").unwrap();
    assert!(store.commit_result(c.clone(), &vault).is_err());
    assert!(page(&store, 1).versions.is_empty());
    assert_eq!(
        crate::presales_queue::store::read_job(&store.connection, "r1")
            .unwrap()
            .unwrap()
            .status,
        JobStatus::ResultReady
    );
    store
        .connection
        .execute("DROP TRIGGER fail_receipt", params![])
        .unwrap();
    store.commit_result(c, &vault).unwrap();
    assert_eq!(page(&store, 1).versions.len(), 1);
}

#[test]
fn local_writer_conflict_is_bounded_and_does_not_admit_partial_queue_rows() {
    let (mut store, dir, _vault) = fixture();
    let other = rusqlite::Connection::open(dir.path().join("catalog.sqlite3")).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let i = input(&store, 1, "r1");
    let started = std::time::Instant::now();
    assert!(store.enqueue_pages(i, None).is_err());
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "local retries must remain short"
    );
    other.execute_batch("ROLLBACK").unwrap();
    assert!(
        crate::presales_queue::store::read_job(&store.connection, "r1")
            .unwrap()
            .is_none()
    );
}

#[test]
fn versions_approvals_drafts_and_delivery_reopen_without_mutating_selection() {
    let (mut store, dir, vault) = fixture();
    for n in 1..=3 {
        let r = format!("r{n}");
        let i = input(&store, n, &r);
        store.enqueue_pages(i, None).unwrap();
        let c = ready(&mut store, &vault, &r);
        store.commit_result(c, &vault).unwrap();
        approve(&mut store, &vault, n);
    }
    store
        .create_delivery_snapshot("frozen-project", &vault)
        .unwrap();
    store
        .save_feedback(SaveFeedback {
            project_id: "frozen-project".into(),
            slide_id: "scenario-1".into(),
            base_version_id: page(&store, 1).current_version_id,
            expected_revision: 0,
            text: "unsubmitted".into(),
        })
        .unwrap();
    let snapshot = store.load_project("frozen-project").unwrap();
    drop(store);
    let reopened = V3Store::open(dir.path().join("catalog.sqlite3")).unwrap();
    assert_eq!(reopened.load_project("frozen-project").unwrap(), snapshot);
}

#[test]
fn maximum_length_attempt_can_be_used_as_a_verified_parent_reference() {
    let (mut store, _dir, vault) = fixture();
    let request = "r".repeat(56);
    let i = input(&store, 1, &request);
    assert_eq!(i.pages[0].attempt_id.len(), 64);
    store.enqueue_pages(i, None).unwrap();
    let c = ready(&mut store, &vault, &request);
    store.commit_result(c, &vault).unwrap();
    let mut next = input(&store, 1, "r2");
    next.pages[0].parent_version_id = page(&store, 1).current_version_id;
    store.enqueue_pages(next, Some(&vault)).unwrap();
}

#[test]
fn native_history_timestamps_are_rfc3339_like_the_frozen_catalog() {
    let (mut store, _dir, vault) = fixture();
    let i = input(&store, 1, "r1");
    store.enqueue_pages(i, None).unwrap();
    let c = ready(&mut store, &vault, "r1");
    let receipt = store.commit_result(c, &vault).unwrap();
    let approval = approve(&mut store, &vault, 1);
    let draft = store
        .save_feedback(SaveFeedback {
            project_id: "frozen-project".into(),
            slide_id: "scenario-1".into(),
            base_version_id: page(&store, 1).current_version_id,
            expected_revision: 0,
            text: "draft".into(),
        })
        .unwrap();
    for timestamp in [
        &receipt.created_at,
        &approval.decided_at,
        &draft.updated_at,
        &page(&store, 1).versions[0].created_at,
    ] {
        assert!(
            chrono::DateTime::parse_from_rfc3339(timestamp).is_ok(),
            "{timestamp}"
        );
    }
}
