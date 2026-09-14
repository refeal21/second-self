use super::*;
use crate::workbench::{AttachSourceInput, CreateProjectInput, WorkbenchService};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

#[path = "acceptance_tests.rs"]
mod acceptance_tests;
#[path = "draft_tests.rs"]
mod draft_tests;
#[path = "provider_tests.rs"]
mod provider_tests;
#[path = "reference_tests.rs"]
mod reference_tests;
#[path = "supervisor_tests.rs"]
mod supervisor_tests;
#[path = "text_tests.rs"]
mod text_tests;

#[path = "../../tests/support/v3_temp.rs"]
mod temp;

struct Fixture {
    root: temp::TempDir,
    legacy: WorkbenchService,
    id: String,
    results: Vec<Value>,
    pair: Value,
}

fn png(color: u8) -> Vec<u8> {
    let mut out = vec![];
    {
        let mut encoder = png::Encoder::new(&mut out, 640, 360);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&vec![color; 640 * 360 * 3])
            .unwrap();
    }
    out
}

impl Fixture {
    /// Explicit synthetic row-contract assembly: the companion comes from real
    /// native joint approval transitions over identical content/approval IDs.
    /// Their draft saves omit Worker task appends. The selected source retains
    /// the complete actual Worker tasks and is checked by BOTH validators.
    fn paired(stop: usize) -> Self {
        let f = Self::new(stop);
        let native = crate::database::Database::open_in_memory().unwrap();
        native
            .insert_project(&crate::database::NewProject {
                id: f.id.clone(),
                name: "Synthetic copy".into(),
                goal: "Offline immutable history".into(),
                created_at: f.results[0]["pipeline"]["project"]["createdAt"]
                    .as_str()
                    .unwrap()
                    .into(),
            })
            .unwrap();
        let mut current = f.results[0]["pipeline"].clone();
        native
            .connection
            .execute(
                "UPDATE projects SET pipeline_json=?1 WHERE id=?2",
                rusqlite::params![current.to_string(), f.id],
            )
            .unwrap();
        let mut last = None;
        for index in 1..5 {
            let mut next = f.results[index]["pipeline"].clone();
            next["tasks"] = current["tasks"].clone();
            let mut pair: crate::presales::PresalesDraftPair =
                serde_json::from_value(f.pair.clone()).unwrap();
            if index < 3 {
                pair.details = None;
            }
            let checkpoint = crate::presales::storage::prepare(
                &native.connection,
                &f.id,
                &current,
                &next,
                Some(&pair),
            )
            .unwrap()
            .unwrap();
            crate::presales::storage::persist(
                &native.connection,
                &f.id,
                next["revision"].as_i64().unwrap(),
                &checkpoint,
                index != 1,
            )
            .unwrap();
            native
                .connection
                .execute(
                    "UPDATE projects SET pipeline_json=?1 WHERE id=?2",
                    rusqlite::params![next.to_string(), f.id],
                )
                .unwrap();
            current = next;
            last = Some(checkpoint);
        }
        let checkpoint = last.unwrap();
        let actual = f.legacy.load_pipeline(&f.id).unwrap();
        crate::presales::storage::validate_loaded(&actual, &checkpoint).unwrap();
        let db = rusqlite::Connection::open(f.root.path().join("legacy.sqlite3")).unwrap();
        crate::presales::storage::persist(
            &db,
            &f.id,
            actual["revision"].as_i64().unwrap(),
            &checkpoint,
            false,
        )
        .unwrap();
        assert_eq!(
            crate::presales::storage::load_on(&db, &f.id)
                .unwrap()
                .pipeline,
            actual
        );
        f
    }
    fn new(stop: usize) -> Self {
        let root = temp::tempdir().unwrap();
        let legacy = WorkbenchService::open(
            root.path().join("legacy.sqlite3"),
            root.path().join("legacy-assets"),
        )
        .unwrap();
        let id = legacy
            .create_project(CreateProjectInput {
                name: "Synthetic copy".into(),
                goal: "Offline immutable history".into(),
            })
            .unwrap()
            .id;
        let pipeline = legacy
            .attach_source(AttachSourceInput {
                project_id: id.clone(),
                file_name: "synthetic.txt".into(),
                media_type: "text/plain".into(),
                contents_base64: STANDARD.encode(b"A confirmed synthetic operating sequence."),
            })
            .unwrap();
        let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
        let mut child = Command::new("node")
            .arg("--import")
            .arg(worker.join("node_modules/tsx/dist/loader.mjs"))
            .arg(worker.join("src/presales/legacy-copy-fixture.test-support.ts"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(json!({"pipeline":pipeline,"png1":STANDARD.encode(png(30)),"png2":STANDARD.encode(png(180))}).to_string().as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let result: Value = serde_json::from_slice(&out.stdout).unwrap();
        legacy.commit_pipeline(serde_json::from_value(json!({"projectId":id,"expectedRevision":pipeline["revision"],"pipeline":result["contextResult"]["pipeline"],"writes":[]})).unwrap()).unwrap();
        let fixture = Self {
            root,
            legacy,
            id,
            results: result["results"].as_array().unwrap().clone(),
            pair: result["pair"].clone(),
        };
        fixture.legacy.save_visual_style(serde_json::from_value(json!({"projectId":fixture.id,"expectedRevision":result["contextResult"]["pipeline"]["revision"],"expectedStyleRevision":0,
            "profile":{"primaryColor":"#112233","backgroundColor":"#FFFFFF","textColor":"#000000","accentColors":[],"instructions":"Synthetic palette","template":null}})).unwrap()).unwrap();
        for index in 0..stop {
            fixture.commit(index);
        }
        fixture
    }
    fn commit(&self, index: usize) {
        let current = self.legacy.load_pipeline(&self.id).unwrap();
        let request = matches!(index, 5 | 8).then(|| format!("upload-{index}"));
        if let Some(id) = &request {
            self.legacy.begin_visual_request(serde_json::from_value(json!({"id":id,"projectId":self.id,"expectedRevision":current["revision"],"styleRevision":1,"slideId":"scenario-1","kind":"upload","prompt":"","feedback":"","promptVersion":"upload-v1"})).unwrap()).unwrap();
        }
        self.legacy.commit_pipeline(serde_json::from_value(json!({"projectId":self.id,"expectedRevision":current["revision"],"pipeline":self.results[index]["pipeline"],"writes":self.results[index]["writes"],"visualRequestId":request,"visualProvider":null})).unwrap()).unwrap();
    }
    fn service(&self) -> V3WorkbenchService {
        let command = {
            let mut c = Command::new(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("binaries/digital-twin-worker-aarch64-apple-darwin"),
            );
            c.arg("--presales-validate");
            c
        };
        V3WorkbenchService::new(
            V3Store::open(self.root.path().join("presales-v3.sqlite3")).unwrap(),
            self.root.path().join("presales-v3-assets"),
            self.legacy.activity().clone(),
            super::validator_process::LegacyValidatorProcess::from_test_command(
                command,
                Duration::from_secs(15),
            ),
        )
        .unwrap()
    }
    fn asset(&self, index: usize) -> PathBuf {
        PathBuf::from(self.legacy.project_directory(&self.id).unwrap()).join(
            self.results[index]["pipeline"]["visuals"]["scenario-1"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["relativePath"]
                .as_str()
                .unwrap(),
        )
    }
}

fn prepare(s: &V3WorkbenchService, f: &Fixture, mode: LegacyCopyMode) -> PreparedLegacyCopySummary {
    s.prepare_legacy_copy(
        &f.legacy,
        PrepareLegacyCopy {
            source_project_id: f.id.clone(),
            mode,
        },
    )
    .unwrap()
}

#[test]
fn historical_omitted_references_receipts_reopen_without_changing_immutable_bytes() {
    for (paired, mode) in [
        (false, LegacyCopyMode::FormatCopy),
        (true, LegacyCopyMode::FormatCopy),
        (true, LegacyCopyMode::PresalesContentRevision),
    ] {
        let f = if paired {
            Fixture::paired(6)
        } else {
            Fixture::new(10)
        };
        let s = f.service();
        let prepared = prepare(&s, &f, mode);
        let copy = s.publish_legacy_copy(&prepared.preparation_id).unwrap();
        let id = copy.summary().project_id.clone();
        drop(s);
        let db = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
        let current: String = db
            .query_row(
                "SELECT receipt_json FROM v3_import_receipts WHERE project_id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        let receipt: super::import_evidence::ImportReceipt =
            serde_json::from_str(&current).unwrap();
        // Exact prior derived-Serialize representation: the final empty page
        // field was skipped. No key reordering or generic JSON normalization.
        assert_eq!(
            current.matches(",\"references\":[]").count(),
            receipt.pages.len()
        );
        assert!(!receipt.pages.is_empty());
        let historical = current.replace(",\"references\":[]", "");
        db.execute(
            "UPDATE v3_import_receipts SET receipt_json=?1 WHERE project_id=?2",
            rusqlite::params![historical, id],
        )
        .unwrap();
        let path = f
            .root
            .path()
            .join("presales-v3-assets")
            .join(&id)
            .join("receipt.json");
        std::fs::write(&path, historical.as_bytes()).unwrap();
        drop(db);
        let reopened = f.service();
        let loaded = reopened
            .load_v3_project(&id)
            .expect("intact historical receipt must reopen through the actual service");
        assert_eq!(loaded, copy);
        let dto = serde_json::to_value(&loaded).unwrap();
        let pages = if loaded.kind() == V3CatalogKind::Draft {
            &dto["project"]["comparisonPages"]
        } else {
            &dto["project"]["pages"]
        };
        assert!(pages
            .as_array()
            .unwrap()
            .iter()
            .all(|page| page["references"] == json!([])));
        assert_eq!(std::fs::read(&path).unwrap(), historical.as_bytes());
        let db = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
        let after: String = db
            .query_row(
                "SELECT receipt_json FROM v3_import_receipts WHERE project_id=?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after, historical);
        // Compatibility is exact, not generic lenient JSON loading. Changing
        // unrelated identity, unknown fields, or canonical layout still fails
        // even if BOTH durable copies contain the same altered bytes.
        for altered in [
            historical.replacen("\"schemaVersion\":1", "\"schemaVersion\":2", 1),
            historical.replacen('{', "{\"unexpected\":true,", 1),
            format!(" {historical}"),
            historical.replacen(
                "\"feedbackDrafts\":[]",
                "\"feedbackDrafts\":[],\"references\":null",
                1,
            ),
        ] {
            db.execute(
                "UPDATE v3_import_receipts SET receipt_json=?1 WHERE project_id=?2",
                rusqlite::params![altered, id],
            )
            .unwrap();
            std::fs::write(&path, altered.as_bytes()).unwrap();
            assert!(reopened.load_v3_project(&id).is_err());
        }
        db.execute(
            "UPDATE v3_import_receipts SET receipt_json=?1 WHERE project_id=?2",
            rusqlite::params![historical, id],
        )
        .unwrap();
        std::fs::write(&path, historical.as_bytes()).unwrap();
        assert_eq!(reopened.load_v3_project(&id).unwrap(), copy);
    }
}

#[test]
fn real_replay_copy_preserves_origin_and_uses_distinct_repeat_copy_ids() {
    let f = Fixture::new(10);
    let s = f.service();
    let before = std::fs::read(f.root.path().join("legacy.sqlite3")).unwrap();
    let first = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    assert_eq!(first.kind, V3CatalogKind::HistoryOnly);
    let a = s.publish_legacy_copy(&first.preparation_id).unwrap();
    let second = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let b = s.publish_legacy_copy(&second.preparation_id).unwrap();
    assert_ne!(a.summary().project_id, b.summary().project_id);
    assert_ne!(a.summary().project_id, f.id);
    assert_eq!(a.pages()[0].versions.len(), 2);
    assert_ne!(
        a.pages()[0].versions[0].version_id,
        b.pages()[0].versions[0].version_id
    );
    assert_ne!(
        a.pages()[0].versions[0].image,
        b.pages()[0].versions[0].image
    );
    assert_ne!(
        a.pages()[0].origin_approval.as_ref().unwrap().reference_id,
        b.pages()[0].origin_approval.as_ref().unwrap().reference_id
    );
    assert!(a.pages()[0]
        .versions
        .iter()
        .all(|v| v.basis.is_none() && v.request_id.is_none()));
    assert!(a.pages()[0].origin_approval.is_some());
    assert_eq!(s.list_project_catalog().unwrap().len(), 2);
    let delivery = s.create_delivery_snapshot(&a.summary().project_id).unwrap();
    assert!(delivery.pages[0].origin_approval_ref.is_some());
    drop(s);
    let s = f.service();
    assert_eq!(s.load_v3_project(&b.summary().project_id).unwrap(), b);
    assert_eq!(
        std::fs::read(f.root.path().join("legacy.sqlite3")).unwrap(),
        before
    );
}

#[test]
fn content_revision_keeps_comparison_history_out_of_live_pages() {
    let f = Fixture::new(10);
    let s = f.service();
    let p = prepare(&s, &f, LegacyCopyMode::PresalesContentRevision);
    let draft = s.publish_legacy_copy(&p.preparation_id).unwrap();
    assert_eq!(draft.kind(), V3CatalogKind::Draft);
    assert!(draft.pages().is_empty());
    assert!(s
        .create_delivery_snapshot(&draft.summary().project_id)
        .is_err());
    let V3WorkbenchProject::Draft(draft) = draft else {
        panic!("explicit draft required")
    };
    assert_eq!(draft.comparison_pages[0].versions.len(), 2);
    assert!(draft.comparison_pages[0].origin_approval.is_none());
    assert_eq!(draft.sources.len(), 1);
    assert!(draft.analysis.is_some());
    assert_eq!(
        draft.context.as_ref().unwrap()["taskBrief"],
        "Preserve the confirmed synthetic brief"
    );
    assert_eq!(draft.brief, "Offline immutable history");
}

#[test]
fn selected_envelope_excludes_other_project_bytes_and_preserves_raw_json_cells() {
    let f = Fixture::new(10);
    let s = f.service();
    let other = f
        .legacy
        .create_project(CreateProjectInput {
            name: "UNRELATED_PRIVATE_SENTINEL".into(),
            goal: "UNRELATED_PRIVATE_SENTINEL".into(),
        })
        .unwrap()
        .id;
    f.legacy
        .attach_source(AttachSourceInput {
            project_id: other.clone(),
            file_name: "unrelated.txt".into(),
            media_type: "text/plain".into(),
            contents_base64: STANDARD.encode(b"UNRELATED_PRIVATE_SENTINEL"),
        })
        .unwrap();
    let source_db = rusqlite::Connection::open(f.root.path().join("legacy.sqlite3")).unwrap();
    let raw: String = source_db.query_row("SELECT record_json FROM visual_generation_records WHERE project_id=?1 ORDER BY rowid LIMIT 1",[&f.id],|r|r.get(0)).unwrap();
    let spaced = format!("  {raw}  ");
    source_db.execute("UPDATE visual_generation_records SET record_json=?1 WHERE id='upload-5' AND project_id=?2",rusqlite::params![spaced,f.id]).unwrap();
    let before = source_files(&f);
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let project = s.publish_legacy_copy(&p.preparation_id).unwrap();
    let root = f.root.path().join("presales-v3-assets");
    let envelope = std::fs::read_to_string(
        root.join(&project.summary().project_id)
            .join("evidence.json"),
    )
    .unwrap();
    assert!(!envelope.contains("UNRELATED_PRIVATE_SENTINEL"));
    let envelope: Value = serde_json::from_str(&envelope).unwrap();
    let cells = envelope["evidence"]["rows"]["visual_generation_records"]["rows"]
        .as_array()
        .unwrap();
    assert!(cells.iter().any(|r| r
        .as_array()
        .unwrap()
        .contains(&Value::String(spaced.clone()))));
    for (index, (actual, expected)) in source_files(&f).iter().zip(&before).enumerate() {
        assert!(
            actual == expected,
            "source main/WAL/SHM bytes changed at index {index}"
        );
    }
    let db = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM v3_artifacts WHERE project_id=?1",
            [&project.summary().project_id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        5
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let path: String = db
            .query_row(
                "SELECT relative_path FROM v3_artifacts WHERE artifact_id=?1",
                [&project.pages()[0].versions[1]
                    .image
                    .as_ref()
                    .unwrap()
                    .asset_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(
            std::fs::metadata(root.join(path)).unwrap().ino(),
            std::fs::metadata(f.asset(8)).unwrap().ino()
        );
    }
}

fn source_files(f: &Fixture) -> Vec<Option<Vec<u8>>> {
    ["legacy.sqlite3", "legacy.sqlite3-wal", "legacy.sqlite3-shm"]
        .iter()
        .map(|name| std::fs::read(f.root.path().join(name)).ok())
        .collect()
}

#[test]
fn history_only_review_adopts_and_restores_exact_origin_reference_without_new_approval() {
    let f = Fixture::new(10);
    let s = f.service();
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let copy = s.publish_legacy_copy(&p.preparation_id).unwrap();
    let project = copy.summary().project_id.clone();
    let old = copy.pages()[0].versions[0].version_id.clone();
    let mut store = V3Store::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    let vault =
        crate::presales_queue::ResultVault::open(f.root.path().join("presales-v3-assets")).unwrap();
    let adopted = store
        .adopt_version(
            AdoptVersion {
                project_id: project.clone(),
                slide_id: "scenario-1".into(),
                version_id: old.clone(),
                expected_revision: 1,
            },
            &vault,
        )
        .unwrap();
    assert!(adopted.origin_approval.is_none());
    assert!(s.create_delivery_snapshot(&project).is_err());
    let restored = store
        .restore_approval(
            AdoptVersion {
                project_id: project.clone(),
                slide_id: "scenario-1".into(),
                version_id: old.clone(),
                expected_revision: adopted.revision,
            },
            &vault,
        )
        .unwrap();
    assert_eq!(
        restored.origin_approval.as_ref().unwrap().source_version_id,
        f.results[5]["pipeline"]["visuals"]["scenario-1"][0]["version"]["id"]
    );
    assert_eq!(
        s.create_delivery_snapshot(&project).unwrap().pages[0].version_id,
        old
    );
    store
        .save_feedback(SaveFeedback {
            project_id: project.clone(),
            slide_id: "scenario-1".into(),
            base_version_id: Some(old),
            expected_revision: 0,
            text: "Historical inspection note".into(),
        })
        .unwrap();
    assert_eq!(
        store
            .connection
            .query_row(
                "SELECT count(*) FROM v3_approvals WHERE project_id=?1",
                [&project],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        s.load_v3_project(&project).unwrap().pages()[0]
            .feedback
            .as_ref()
            .unwrap()
            .text,
        "Historical inspection note"
    );
}

#[test]
fn reopened_latest_does_not_reactivate_historical_approval_and_missing_history_is_visible() {
    let f = Fixture::new(9);
    let s = f.service();
    std::fs::remove_file(f.asset(5)).unwrap();
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let copy = s.publish_legacy_copy(&p.preparation_id).unwrap();
    assert!(copy.pages()[0].origin_approval.is_none());
    assert_eq!(
        copy.pages()[0].versions[0].missing_image.as_deref(),
        Some("source_history_image_missing")
    );
    assert_eq!(copy.pages()[0].origin_approvals.len(), 0);
    let Some(V3VisualProvenance::LegacyImported {
        original_visual,
        original_approval,
        ..
    }) = &copy.pages()[0].versions[0].provenance
    else {
        panic!("missing original history metadata")
    };
    assert_eq!(original_visual["version"]["status"], "frozen");
    assert_eq!(original_approval.as_ref().unwrap()["status"], "approved");
    assert!(s
        .create_delivery_snapshot(&copy.summary().project_id)
        .is_err());
}

#[test]
fn required_current_bytes_and_source_review_changes_block_publication() {
    let f = Fixture::new(9);
    let s = f.service();
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    std::fs::write(f.asset(8), png(90)).unwrap();
    assert!(s.publish_legacy_copy(&p.preparation_id).is_err());
    assert!(s.list_project_catalog().unwrap().is_empty());
    assert!(s
        .prepare_legacy_copy(
            &f.legacy,
            PrepareLegacyCopy {
                source_project_id: f.id.clone(),
                mode: LegacyCopyMode::FormatCopy
            }
        )
        .is_err());
}

#[test]
fn cross_validated_frozen_copy_accepts_new_native_generation_and_preserves_imported_candidate() {
    use crate::presales_queue::{result_staging::result_binding, store::read_job, ResultVault};
    // An unapproved legacy candidate has only the two content approvals and is
    // admitted by both unchanged validators. This is row-contract coverage,
    // not a claim that the paired production writer emits legacy candidates.
    let f = Fixture::paired(6);
    let s = f.service();
    let prepared = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    assert_eq!(prepared.kind, V3CatalogKind::Frozen);
    let copied = s.publish_legacy_copy(&prepared.preparation_id).unwrap();
    assert_eq!(copied.pages()[0].versions.len(), 1);
    assert!(copied.pages()[0].versions[0].basis.is_none());
    let project = copied.summary().project_id.clone();
    let mut store = V3Store::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    let vault = ResultVault::open(f.root.path().join("presales-v3-assets")).unwrap();
    store
        .enqueue_pages(
            EnqueuePages {
                project_id: project.clone(),
                batch_id: "new-native-batch".into(),
                pages: vec![PageRequest {
                    slide_id: "scenario-1".into(),
                    request_id: "new-native".into(),
                    attempt_id: "new-native-attempt".into(),
                    expected_revision: 1,
                    parent_version_id: None,
                    feedback: "More space".into(),
                }],
            },
            None,
        )
        .unwrap();
    let tx = store.connection.transaction().unwrap();
    crate::presales_queue::store::claim_next_on(&tx, 0)
        .unwrap()
        .unwrap();
    tx.commit().unwrap();
    let job = read_job(&store.connection, "new-native").unwrap().unwrap();
    let verified = vault
        .stage(&result_binding(&job).unwrap(), &png(110))
        .unwrap();
    let tx = store.connection.transaction().unwrap();
    crate::presales_queue::lifecycle::record_result_evidence(&tx, job, verified.manifest().clone())
        .unwrap();
    tx.commit().unwrap();
    store
        .commit_result(
            CommitResult {
                epoch: 0,
                request_id: "new-native".into(),
                attempt_id: "new-native-attempt".into(),
            },
            &vault,
        )
        .unwrap();
    let loaded = store.load_project(&project).unwrap();
    assert_eq!(loaded.pages[0].versions.len(), 2);
    assert_eq!(loaded.pages[0].versions[1].sequence, 2);
    let v = &loaded.pages[0].versions[1];
    store
        .approve_version(
            ApproveVersion {
                project_id: project.clone(),
                slide_id: "scenario-1".into(),
                version_id: v.version_id.clone(),
                image_sha256: v.image.as_ref().unwrap().sha256.clone(),
                basis: v.basis.clone().unwrap(),
                expected_revision: loaded.pages[0].revision,
                content_checked: true,
                visual_checked: true,
            },
            &vault,
        )
        .unwrap();
    assert!(store
        .create_delivery_snapshot(&project, &vault)
        .unwrap()
        .pages[0]
        .origin_approval_ref
        .is_none());
    // A native candidate cannot use the project's import receipt to mask a
    // missing native lifecycle audit.
    store
        .connection
        .execute(
            "DELETE FROM queue_lifecycle_events WHERE request_id='new-native' AND kind='published'",
            [],
        )
        .unwrap();
    assert!(store.load_project(&project).is_err());
    assert!(s.load_v3_project(&project).is_err());
}

#[test]
fn cross_validated_pair_without_visuals_is_frozen_but_not_deliverable() {
    let f = Fixture::paired(5);
    let s = f.service();
    let prepared = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let project = s.publish_legacy_copy(&prepared.preparation_id).unwrap();
    assert_eq!(project.kind(), V3CatalogKind::Frozen);
    let V3WorkbenchProject::Frozen(ref frozen) = project else {
        unreachable!()
    };
    assert_eq!(
        frozen.origin.hash_algorithm,
        "legacy-source-snapshot-sha256-v1"
    );
    let V3FrozenEvidence::Native(evidence) = &frozen.frozen_checkpoint else {
        panic!()
    };
    assert_eq!(evidence.pipeline["project"]["id"], f.id);
    assert!(project.pages()[0].versions.is_empty());
    assert!(s
        .create_delivery_snapshot(&project.summary().project_id)
        .is_err());
}

#[test]
fn actual_v2_structural_revision_replay_copies_both_modes_without_rewriting_history() {
    let f = Fixture::new(4);
    f.commit(10);
    f.commit(11);
    let source = f.legacy.load_pipeline(&f.id).unwrap();
    assert_eq!(source["schemaVersion"], 2);
    let s = f.service();
    for mode in [
        LegacyCopyMode::FormatCopy,
        LegacyCopyMode::PresalesContentRevision,
    ] {
        let p = prepare(&s, &f, mode);
        let project = s.publish_legacy_copy(&p.preparation_id).unwrap();
        let db = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
        let raw: String = db
            .query_row(
                "SELECT receipt_json FROM v3_import_receipts WHERE project_id=?1",
                [&project.summary().project_id],
                |r| r.get(0),
            )
            .unwrap();
        let receipt: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(receipt["pipeline"], source);
        assert_eq!(
            s.load_v3_project(&project.summary().project_id).unwrap(),
            project
        );
    }
}

#[test]
fn preexisting_unknown_activity_and_historical_unreceipted_generation_block_prepare() {
    for unknown in [true, false] {
        let f = Fixture::new(9);
        let s = f.service();
        if unknown {
            let tracker = f.legacy.activity();
            let process = tracker.process_key(super::activity::Transport::Codex, 73);
            tracker
                .send(
                    &process,
                    &json!({"id":1,"method":"future/unknown/write","params":{}}).to_string(),
                    |_| None,
                    || Ok(()),
                )
                .unwrap();
        } else {
            f.legacy.begin_visual_request(serde_json::from_value(json!({"id":"unreceipted-generation","projectId":f.id,"expectedRevision":f.legacy.load_pipeline(&f.id).unwrap()["revision"],"styleRevision":1,"slideId":"scenario-1","kind":"imagegen","prompt":"synthetic unexecuted request","feedback":"","promptVersion":"test-v1"})).unwrap()).unwrap();
            // Native pre-dispatch coverage is deliberately safe. Model an old
            // unreceipted row with no matching observed coverage instead.
            let db = rusqlite::Connection::open(f.root.path().join("legacy.sqlite3")).unwrap();
            db.execute("UPDATE visual_generation_records SET id='historical-unknown',record_json=json_set(record_json,'$.id','historical-unknown') WHERE id='unreceipted-generation'",[]).unwrap();
        }
        assert!(s
            .prepare_legacy_copy(
                &f.legacy,
                PrepareLegacyCopy {
                    source_project_id: f.id.clone(),
                    mode: LegacyCopyMode::FormatCopy
                }
            )
            .is_err());
        assert!(s.list_project_catalog().unwrap().is_empty());
    }
}

#[test]
fn unapproved_imported_history_cannot_be_silently_deleted() {
    let f = Fixture::new(6);
    let s = f.service();
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let project = s.publish_legacy_copy(&p.preparation_id).unwrap();
    let id = &project.summary().project_id;
    let db = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    db.pragma_update(None, "foreign_keys", false).unwrap();
    db.execute(
        "UPDATE v3_pages SET current_version_id=NULL WHERE project_id=?1",
        [id],
    )
    .unwrap();
    db.execute("DELETE FROM v3_versions WHERE project_id=?1", [id])
        .unwrap();
    assert!(s.load_v3_project(id).is_err());
}

#[test]
fn copy_requires_current_image_and_verified_source_and_analysis_bytes() {
    for target in ["current", "source", "analysis"] {
        let f = Fixture::new(9);
        let s = f.service();
        let p = f.legacy.load_pipeline(&f.id).unwrap();
        let path = match target {
            "current" => f.asset(8),
            "source" => PathBuf::from(f.legacy.project_directory(&f.id).unwrap())
                .join(p["sources"][0]["relativePath"].as_str().unwrap()),
            _ => PathBuf::from(f.legacy.project_directory(&f.id).unwrap())
                .join(p["analysis"]["artifactRelativePath"].as_str().unwrap()),
        };
        std::fs::remove_file(path).unwrap();
        let error = s
            .prepare_legacy_copy(
                &f.legacy,
                PrepareLegacyCopy {
                    source_project_id: f.id.clone(),
                    mode: LegacyCopyMode::FormatCopy,
                },
            )
            .unwrap_err();
        assert!(
            error.contains("required_source_asset_missing"),
            "{target}: {error}"
        );
        assert!(s.list_project_catalog().unwrap().is_empty());
    }
}

#[test]
fn source_database_change_and_new_unknown_activity_invalidate_preparation() {
    for activity in [false, true] {
        let f = Fixture::new(9);
        let s = f.service();
        let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
        if activity {
            let tracker = f.legacy.activity();
            let process = tracker.process_key(super::activity::Transport::Codex, 72);
            tracker
                .send(
                    &process,
                    &json!({"id":1,"method":"future/unknown/write","params":{}}).to_string(),
                    |_| None,
                    || Ok(()),
                )
                .unwrap();
        } else {
            f.commit(9);
        }
        assert!(s.publish_legacy_copy(&p.preparation_id).is_err());
        assert!(s.list_project_catalog().unwrap().is_empty());
    }
}

#[test]
fn malformed_full_replay_and_unsafe_current_path_are_rejected() {
    for mutation in ["approval", "path"] {
        let f = Fixture::new(9);
        let s = f.service();
        let db = rusqlite::Connection::open(f.root.path().join("legacy.sqlite3")).unwrap();
        let mut p = f.legacy.load_pipeline(&f.id).unwrap();
        if mutation == "approval" {
            p["approvals"][0]["id"] = json!("forged-approval");
        } else {
            p["visuals"]["scenario-1"][1]["relativePath"] = json!("../escape.png");
        }
        db.execute(
            "UPDATE projects SET pipeline_json=?1 WHERE id=?2",
            rusqlite::params![p.to_string(), f.id],
        )
        .unwrap();
        assert!(s
            .prepare_legacy_copy(
                &f.legacy,
                PrepareLegacyCopy {
                    source_project_id: f.id.clone(),
                    mode: LegacyCopyMode::FormatCopy
                }
            )
            .is_err());
        assert!(s.list_project_catalog().unwrap().is_empty());
    }
}

#[test]
fn atomic_publication_failure_leaves_no_catalog_receipt_pages_or_files() {
    for table in ["v3_import_receipts", "v3_versions", "v3_artifacts"] {
        let f = Fixture::new(10);
        let s = f.service();
        let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
        let db = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
        db.execute_batch(&format!("CREATE TRIGGER injected_failure BEFORE INSERT ON {table} BEGIN SELECT RAISE(ABORT,'synthetic publication failure'); END")).unwrap();
        let error = s.publish_legacy_copy(&p.preparation_id).unwrap_err();
        assert!(error.contains("synthetic publication failure"), "{error}");
        db.execute_batch("DROP TRIGGER injected_failure").unwrap();
        for table in [
            "v3_catalog",
            "v3_import_receipts",
            "v3_pages",
            "v3_versions",
            "v3_artifacts",
        ] {
            assert_eq!(
                db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
        let dir = f
            .root
            .path()
            .join("presales-v3-assets")
            .join(&p.destination.project_id);
        assert!(!dir.join("receipt.json").exists());
        assert!(!dir.join("evidence.json").exists());
        assert_eq!(std::fs::read_dir(dir.join("assets")).unwrap().count(), 0);
        drop(s);
        assert!(f.service().list_project_catalog().unwrap().is_empty());
    }
}

#[test]
fn immutable_receipt_asset_index_and_origin_reference_tampering_fail_closed() {
    for mutation in [
        "receipt",
        "asset",
        "approval",
        "missing_approval",
        "version",
    ] {
        let f = Fixture::new(10);
        let s = f.service();
        let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
        let project = s.publish_legacy_copy(&p.preparation_id).unwrap();
        let id = &project.summary().project_id;
        let db = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
        match mutation {
            "receipt" => {
                db.execute("UPDATE v3_import_receipts SET receipt_json=json_set(receipt_json,'$.origin.sourceRevision',999) WHERE project_id=?1",[id]).unwrap();
            }
            "asset" => {
                db.execute("UPDATE v3_artifacts SET metadata_json='{}' WHERE project_id=?1 AND version_id IS NOT NULL",[id]).unwrap();
            }
            "approval" => {
                db.execute("UPDATE v3_origin_approvals SET proof_json=json_set(proof_json,'$.sourceApproval.id','invented') WHERE project_id=?1",[id]).unwrap();
            }
            "missing_approval" => {
                db.execute("DELETE FROM v3_origin_approvals WHERE project_id=?1", [id])
                    .unwrap();
            }
            _ => {
                db.execute("UPDATE v3_versions SET version_json=json_set(version_json,'$.basis',json('{}')) WHERE project_id=?1",[id]).unwrap();
            }
        }
        assert!(s.load_v3_project(id).is_err(), "{mutation}");
        assert!(s.create_delivery_snapshot(id).is_err(), "{mutation}");
    }
}

#[test]
fn original_approval_requires_saved_candidate_checkpoint_and_each_receipt_link() {
    for mutation in ["checkpoint", "spec", "receipt", "decision", "artifact"] {
        let f = Fixture::new(10);
        let s = f.service();
        let db = rusqlite::Connection::open(f.root.path().join("legacy.sqlite3")).unwrap();
        match mutation {
            "checkpoint" => {
                db.execute("DELETE FROM checkpoints WHERE project_id=?1 AND json_extract(pipeline_json,'$.revision')=?2",rusqlite::params![f.id,f.results[8]["pipeline"]["revision"].as_i64().unwrap()]).unwrap();
            }
            "spec" => {
                db.execute("UPDATE visual_generation_records SET record_json=json_set(record_json,'$.specSha256',?1) WHERE project_id=?2 AND id='upload-8'",rusqlite::params!["a".repeat(64),f.id]).unwrap();
            }
            "receipt" => {
                db.execute("UPDATE visual_generation_records SET record_json=json_set(record_json,'$.receipt',NULL) WHERE project_id=?1 AND id='upload-8'",[&f.id]).unwrap();
            }
            "decision" => {
                db.execute(
                    "DELETE FROM approvals WHERE project_id=?1 AND version_id=?2",
                    rusqlite::params![
                        f.id,
                        f.results[9]["pipeline"]["visuals"]["scenario-1"][1]["version"]["id"]
                            .as_str()
                            .unwrap()
                    ],
                )
                .unwrap();
            }
            _ => {
                db.execute(
                    "DELETE FROM artifacts WHERE project_id=?1 AND version_id=?2",
                    rusqlite::params![
                        f.id,
                        f.results[9]["pipeline"]["visuals"]["scenario-1"][1]["version"]["id"]
                            .as_str()
                            .unwrap()
                    ],
                )
                .unwrap();
            }
        }
        let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
        let copy = s.publish_legacy_copy(&p.preparation_id).unwrap();
        assert!(
            copy.pages()[0].origin_approval.is_none(),
            "missing {mutation} must disable original delivery authority"
        );
        assert!(s
            .create_delivery_snapshot(&copy.summary().project_id)
            .is_err());
    }
}

#[test]
fn external_wal_change_after_review_is_stale_without_any_tracker_mutation() {
    let f = Fixture::new(9);
    let s = f.service();
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let db = rusqlite::Connection::open(f.root.path().join("legacy.sqlite3")).unwrap();
    db.execute(
        "UPDATE projects SET goal='changed externally' WHERE id=?1",
        [&f.id],
    )
    .unwrap();
    let error = s.publish_legacy_copy(&p.preparation_id).unwrap_err();
    assert!(error.contains("source_changed"), "{error}");
    assert!(s.list_project_catalog().unwrap().is_empty());
}

#[test]
fn staged_byte_tampering_discards_publication_and_preparation_is_not_frontend_authority() {
    let f = Fixture::new(9);
    let s = f.service();
    assert!(serde_json::from_value::<PrepareLegacyCopy>(
        json!({"sourceProjectId":f.id,"mode":"format_copy","valid":true,"replayToken":{}})
    )
    .is_err());
    assert!(s.publish_legacy_copy("invented-preparation").is_err());
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let dir = f
        .root
        .path()
        .join("presales-v3-assets")
        .join(&p.destination.project_id);
    let asset = std::fs::read_dir(dir.join("assets"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::write(asset, b"corrupted copied bytes").unwrap();
    assert!(s.publish_legacy_copy(&p.preparation_id).is_err());
    assert!(s.list_project_catalog().unwrap().is_empty());
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    s.discard_legacy_copy(&p.preparation_id).unwrap();
    assert!(s.publish_legacy_copy(&p.preparation_id).is_err());
}

#[cfg(unix)]
#[test]
fn source_symlinks_and_same_hash_wrong_png_bytes_are_never_admitted() {
    let f = Fixture::new(9);
    let s = f.service();
    let path = f.asset(8);
    let contents = std::fs::read(&path).unwrap();
    let renamed = path.with_extension("kept");
    std::fs::rename(&path, &renamed).unwrap();
    std::os::unix::fs::symlink(&renamed, &path).unwrap();
    assert!(s
        .prepare_legacy_copy(
            &f.legacy,
            PrepareLegacyCopy {
                source_project_id: f.id.clone(),
                mode: LegacyCopyMode::FormatCopy
            }
        )
        .is_err());
    std::fs::remove_file(&path).unwrap();
    // Give the pipeline the true hash/length of invalid PNG bytes, so hash-only
    // validation cannot satisfy this test.
    let invalid = b"not a PNG";
    std::fs::write(&path, invalid).unwrap();
    let mut p = f.legacy.load_pipeline(&f.id).unwrap();
    p["visuals"]["scenario-1"][1]["sha256"] = json!(super::import_assets::hash(invalid));
    p["visuals"]["scenario-1"][1]["byteLength"] = json!(invalid.len());
    let db = rusqlite::Connection::open(f.root.path().join("legacy.sqlite3")).unwrap();
    db.execute(
        "UPDATE projects SET pipeline_json=?1 WHERE id=?2",
        rusqlite::params![p.to_string(), f.id],
    )
    .unwrap();
    let error = s
        .prepare_legacy_copy(
            &f.legacy,
            PrepareLegacyCopy {
                source_project_id: f.id.clone(),
                mode: LegacyCopyMode::FormatCopy,
            },
        )
        .unwrap_err();
    assert!(error.contains("PNG"), "{error}");
    assert!(!contents.is_empty());
}
