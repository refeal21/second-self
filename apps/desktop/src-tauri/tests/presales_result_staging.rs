use digital_twin_desktop_lib::presales_queue::{
    EnqueueBatch, EnqueueJob, JobStatus, ProviderIdentity, QueueJob, QueueStore, QueueTarget,
    ResultBinding, ResultVault, VersionHash,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

struct FixturePaths {
    base: PathBuf,
    db: PathBuf,
    root: PathBuf,
}

impl FixturePaths {
    fn new(label: &str) -> Self {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "presales-result-staging-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&base).unwrap();
        let root = base.join("native-result-root");
        fs::create_dir(&root).unwrap();
        let db = base.join("queue.sqlite3");
        Self { base, db, root }
    }
}

impl Drop for FixturePaths {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}

fn version() -> VersionHash {
    VersionHash {
        version: "v1".into(),
        sha256: "a".repeat(64),
    }
}

fn target(slide: &str) -> QueueTarget {
    QueueTarget {
        project_id: "synthetic".into(),
        slide_id: slide.into(),
        spec: version(),
        design: version(),
        skill: version(),
        palette: version(),
        parent_visual: None,
        references: Vec::new(),
        prompt_version: "v1".into(),
        prompt: format!("Synthetic staging test for {slide}"),
        feedback: String::new(),
    }
}

fn batch(batch_id: &str, jobs: &[(&str, &str, &str)]) -> EnqueueBatch {
    EnqueueBatch {
        batch_id: batch_id.into(),
        jobs: jobs
            .iter()
            .map(|(request_id, attempt_id, slide_id)| EnqueueJob {
                request_id: (*request_id).into(),
                attempt_id: (*attempt_id).into(),
                target: target(slide_id),
            })
            .collect(),
    }
}

fn solid_png(width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(Cursor::new(&mut bytes), width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().unwrap();
    writer
        .write_image_data(&color.repeat((width * height) as usize))
        .unwrap();
    writer.finish().unwrap();
    bytes
}

fn binding(job: &QueueJob) -> ResultBinding {
    let target_json = serde_json::to_vec(&job.target).unwrap();
    ResultBinding {
        request_id: job.request_id.clone(),
        attempt_id: job.attempt_id.clone(),
        target_sha256: format!("{:x}", Sha256::digest(target_json)),
    }
}

fn dispatched(label: &str) -> (FixturePaths, QueueStore, ResultVault, i64, QueueJob) {
    let paths = FixturePaths::new(label);
    let mut store = QueueStore::open(&paths.db).unwrap();
    store.enqueue(batch("b1", &[("r1", "a1", "s1")])).unwrap();
    let epoch = store.begin_runtime().unwrap().settings.epoch;
    let job = store.claim_next(epoch).unwrap().unwrap();
    let vault = ResultVault::open(&paths.root).unwrap();
    (paths, store, vault, epoch, job)
}

fn result_events(store: &QueueStore, request_id: &str) -> usize {
    store
        .events(request_id)
        .unwrap()
        .iter()
        .filter(|event| event.kind == "result_ready")
        .count()
}

fn assert_no_result_files(root: &Path) {
    assert!(!root.join("queue-results").exists());
}

#[test]
fn stage_and_recover_are_exact_replays_across_restart_and_revalidate_ready_bytes() {
    let (paths, mut store, vault, epoch, _) = dispatched("replay");
    let png = solid_png(16, 9, [11, 22, 33]);
    let ready = store
        .stage_png_result(&vault, epoch, "r1", "a1", &png)
        .unwrap();
    let sidecar_path = paths.root.join("queue-results/r1/a1.json");
    let original_sidecar = fs::read(&sidecar_path).unwrap();
    assert_eq!(ready.status, JobStatus::ResultReady);
    assert_eq!(ready.result.as_ref().unwrap().byte_length, png.len() as u64);
    let before = store.events("r1").unwrap();
    assert_eq!(
        store.recover_png_result(&vault, epoch, "r1", "a1").unwrap(),
        ready
    );
    assert_eq!(store.events("r1").unwrap(), before);
    assert_eq!(result_events(&store, "r1"), 1);

    drop(store);
    let mut store = QueueStore::open(&paths.db).unwrap();
    let epoch2 = store.begin_runtime().unwrap().settings.epoch;
    assert_eq!(
        store
            .recover_png_result(&ResultVault::open(&paths.root).unwrap(), epoch2, "r1", "a1",)
            .unwrap(),
        ready
    );
    assert_eq!(result_events(&store, "r1"), 1);

    let unchanged = store.get_job("r1").unwrap().unwrap();
    let mut wrong_manifest: serde_json::Value = serde_json::from_slice(&original_sidecar).unwrap();
    wrong_manifest["binding"]["targetSha256"] = serde_json::Value::String("f".repeat(64));
    fs::write(&sidecar_path, serde_json::to_vec(&wrong_manifest).unwrap()).unwrap();
    assert!(store
        .recover_png_result(&ResultVault::open(&paths.root).unwrap(), epoch2, "r1", "a1",)
        .is_err());
    assert_eq!(store.get_job("r1").unwrap(), Some(unchanged.clone()));
    assert_eq!(result_events(&store, "r1"), 1);
    fs::write(&sidecar_path, original_sidecar).unwrap();
    assert_eq!(
        store
            .recover_png_result(&ResultVault::open(&paths.root).unwrap(), epoch2, "r1", "a1",)
            .unwrap(),
        unchanged
    );

    fs::write(
        paths.root.join("queue-results/r1/a1.png"),
        solid_png(4, 3, [44, 55, 66]),
    )
    .unwrap();
    let unchanged = store.get_job("r1").unwrap().unwrap();
    assert!(store
        .recover_png_result(&ResultVault::open(&paths.root).unwrap(), epoch2, "r1", "a1",)
        .is_err());
    assert_eq!(store.get_job("r1").unwrap(), Some(unchanged));
    assert_eq!(result_events(&store, "r1"), 1);
}

#[test]
fn running_and_outcome_unknown_attempts_accept_native_staging() {
    let (_paths, mut running_store, running_vault, epoch, _) = dispatched("running");
    running_store
        .record_provider(
            epoch,
            "r1",
            "a1",
            ProviderIdentity {
                thread_id: "synthetic-thread".into(),
                turn_id: None,
            },
        )
        .unwrap();
    assert_eq!(
        running_store
            .stage_png_result(
                &running_vault,
                epoch,
                "r1",
                "a1",
                &solid_png(2, 2, [1, 2, 3]),
            )
            .unwrap()
            .status,
        JobStatus::ResultReady
    );

    let (_paths, mut unknown_store, unknown_vault, epoch, _) = dispatched("unknown");
    unknown_store
        .mark_outcome_unknown(epoch, "r1", "a1", "synthetic disconnect")
        .unwrap();
    assert_eq!(
        unknown_store
            .stage_png_result(
                &unknown_vault,
                epoch,
                "r1",
                "a1",
                &solid_png(2, 2, [4, 5, 6]),
            )
            .unwrap()
            .status,
        JobStatus::ResultReady
    );
}

#[test]
fn terminal_jobs_cannot_be_promoted_or_create_result_files() {
    for terminal in ["failed", "cancelled", "succeeded", "abandoned"] {
        let (paths, mut store, vault, epoch, _) = dispatched(terminal);
        match terminal {
            "failed" => {
                store
                    .mark_failed(epoch, "r1", "a1", "synthetic failure")
                    .unwrap();
            }
            "cancelled" => {
                store.confirm_cancelled(epoch, "r1", "a1").unwrap();
            }
            "succeeded" => {
                Connection::open(&paths.db)
                    .unwrap()
                    .execute(
                        "UPDATE queue_jobs SET status = 'succeeded' WHERE request_id = 'r1'",
                        [],
                    )
                    .unwrap();
            }
            "abandoned" => {
                store
                    .mark_outcome_unknown(epoch, "r1", "a1", "synthetic disconnect")
                    .unwrap();
                store.abandon_unresolved("r1", true).unwrap();
            }
            _ => unreachable!(),
        }
        let before = store.get_job("r1").unwrap().unwrap();
        assert!(store
            .stage_png_result(&vault, epoch, "r1", "a1", &solid_png(2, 2, [7, 8, 9]),)
            .is_err());
        assert_eq!(store.get_job("r1").unwrap(), Some(before));
        assert_no_result_files(&paths.root);
    }
}

#[test]
fn recovery_records_a_previously_staged_attempt_after_runtime_restart() {
    let (paths, store, vault, first_epoch, job) = dispatched("pre-staged");
    let verified = vault
        .stage(&binding(&job), &solid_png(16, 9, [1, 2, 3]))
        .unwrap();
    assert_eq!(store.get_job("r1").unwrap().unwrap().result, None);
    drop(store);

    let mut reopened = QueueStore::open(&paths.db).unwrap();
    let second_epoch = reopened.begin_runtime().unwrap().settings.epoch;
    assert_eq!(second_epoch, first_epoch + 1);
    let ready = reopened
        .recover_png_result(
            &ResultVault::open(&paths.root).unwrap(),
            second_epoch,
            "r1",
            "a1",
        )
        .unwrap();
    assert_eq!(ready.status, JobStatus::ResultReady);
    assert_eq!(ready.result.as_ref(), Some(verified.manifest()));
    assert_eq!(ready.attempt_id, "a1");
    assert_eq!(result_events(&reopened, "r1"), 1);
}

#[test]
fn sqlite_recording_failure_preserves_verified_files_for_recovery() {
    let (paths, mut store, vault, epoch, original) = dispatched("sqlite-failure");
    Connection::open(&paths.db)
        .unwrap()
        .execute_batch(
            "CREATE TRIGGER reject_staged_result BEFORE INSERT ON queue_lifecycle_events
             WHEN NEW.kind = 'result_ready'
             BEGIN SELECT RAISE(FAIL, 'synthetic recording failure'); END;",
        )
        .unwrap();
    let png = solid_png(16, 9, [7, 8, 9]);
    assert!(store
        .stage_png_result(&vault, epoch, "r1", "a1", &png)
        .is_err());
    assert_eq!(store.get_job("r1").unwrap(), Some(original.clone()));
    assert_eq!(result_events(&store, "r1"), 0);
    assert_eq!(
        vault
            .recover(&binding(&original))
            .unwrap()
            .manifest()
            .byte_length,
        png.len() as u64
    );

    Connection::open(&paths.db)
        .unwrap()
        .execute_batch("DROP TRIGGER reject_staged_result;")
        .unwrap();
    let ready = store.recover_png_result(&vault, epoch, "r1", "a1").unwrap();
    assert_eq!(ready.status, JobStatus::ResultReady);
    assert_eq!(result_events(&store, "r1"), 1);
}

#[test]
fn ineligible_or_invalid_inputs_do_not_write_files_or_change_queue_state() {
    let (paths, mut store, vault, epoch, original) = dispatched("preflight");
    let png = solid_png(2, 2, [1, 1, 1]);
    assert!(store
        .stage_png_result(&vault, epoch + 1, "r1", "a1", &png)
        .is_err());
    assert!(store
        .stage_png_result(&vault, epoch, "r1", "wrong", &png)
        .is_err());
    assert!(store
        .stage_png_result(&vault, epoch, "missing", "a1", &png)
        .is_err());
    assert!(store
        .stage_png_result(&vault, epoch, "r1", "a1", b"not a png")
        .is_err());
    assert!(store.recover_png_result(&vault, epoch, "r1", "a1").is_err());
    assert_no_result_files(&paths.root);
    assert_eq!(store.get_job("r1").unwrap(), Some(original));

    store.enqueue(batch("b2", &[("r2", "a2", "s2")])).unwrap();
    assert!(store
        .stage_png_result(&vault, epoch, "r2", "a2", &png)
        .is_err());
    assert_no_result_files(&paths.root);
    assert_eq!(
        store.get_job("r2").unwrap().unwrap().status,
        JobStatus::Queued
    );
}

#[test]
fn missing_corrupt_or_wrong_binding_evidence_never_changes_an_active_job() {
    for case in ["missing", "corrupt", "wrong-binding"] {
        let (paths, mut store, vault, epoch, original) = dispatched(case);
        if case != "missing" {
            let mut direct_binding = binding(&original);
            if case == "wrong-binding" {
                direct_binding.target_sha256 = "f".repeat(64);
            }
            vault
                .stage(&direct_binding, &solid_png(2, 2, [2, 3, 4]))
                .unwrap();
            if case == "corrupt" {
                fs::write(paths.root.join("queue-results/r1/a1.png"), b"corrupt").unwrap();
            }
        }
        assert!(store.recover_png_result(&vault, epoch, "r1", "a1").is_err());
        assert_eq!(store.get_job("r1").unwrap(), Some(original));
        assert_eq!(result_events(&store, "r1"), 0);
    }
}

#[test]
fn out_of_order_pages_stage_across_connections_without_replacement_or_success() {
    let paths = FixturePaths::new("out-of-order");
    let mut first = QueueStore::open(&paths.db).unwrap();
    first.set_concurrency(2).unwrap();
    first
        .enqueue(batch("b1", &[("r1", "a1", "s1"), ("r2", "a2", "s2")]))
        .unwrap();
    let epoch = first.begin_runtime().unwrap().settings.epoch;
    first.claim_next(epoch).unwrap().unwrap();
    first.claim_next(epoch).unwrap().unwrap();
    let mut second = QueueStore::open(&paths.db).unwrap();

    let png2 = solid_png(4, 3, [2, 2, 2]);
    let ready2 = second
        .stage_png_result(
            &ResultVault::open(&paths.root).unwrap(),
            epoch,
            "r2",
            "a2",
            &png2,
        )
        .unwrap();
    let png1 = solid_png(16, 9, [1, 1, 1]);
    let ready1 = first
        .stage_png_result(
            &ResultVault::open(&paths.root).unwrap(),
            epoch,
            "r1",
            "a1",
            &png1,
        )
        .unwrap();
    assert_eq!(ready1.status, JobStatus::ResultReady);
    assert_eq!(ready2.status, JobStatus::ResultReady);
    assert_eq!(
        second
            .stage_png_result(
                &ResultVault::open(&paths.root).unwrap(),
                epoch,
                "r2",
                "a2",
                &png2,
            )
            .unwrap(),
        ready2
    );
    assert_eq!(result_events(&first, "r1"), 1);
    assert_eq!(result_events(&first, "r2"), 1);
    assert!(first
        .list_jobs()
        .unwrap()
        .iter()
        .all(|job| job.status != JobStatus::Succeeded));

    let reused = first
        .enqueue(batch("b2", &[("r3", "a3", "s1"), ("r4", "a4", "s2")]))
        .unwrap();
    assert_eq!(reused.reused_request_ids, vec!["r1", "r2"]);
    assert_eq!(first.list_jobs().unwrap().len(), 2);
}

#[test]
fn cancellation_order_is_preserved_for_staged_and_recovered_results() {
    let (_paths, mut store, vault, epoch, _) = dispatched("cancel-first");
    store.request_cancel("r1").unwrap();
    let cancelled = store
        .stage_png_result(&vault, epoch, "r1", "a1", &solid_png(2, 2, [1, 2, 3]))
        .unwrap();
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    assert_eq!(cancelled.result, None);
    assert_eq!(result_events(&store, "r1"), 1);

    let (paths, mut store, vault, _, job) = dispatched("cancel-restart");
    vault
        .stage(&binding(&job), &solid_png(2, 2, [4, 5, 6]))
        .unwrap();
    store.request_cancel("r1").unwrap();
    let recovered_epoch = store.begin_runtime().unwrap().settings.epoch;
    let cancelled = store
        .recover_png_result(&vault, recovered_epoch, "r1", "a1")
        .unwrap();
    assert_eq!(cancelled.status, JobStatus::Cancelled);
    assert_eq!(cancelled.result, None);
    assert!(paths.root.join("queue-results/r1/a1.json").exists());

    let (_paths, mut store, vault, epoch, _) = dispatched("result-first");
    let ready = store
        .stage_png_result(&vault, epoch, "r1", "a1", &solid_png(2, 2, [7, 8, 9]))
        .unwrap();
    assert!(store.request_cancel("r1").is_err());
    assert_eq!(store.get_job("r1").unwrap(), Some(ready));
}

#[test]
fn abandonment_keeps_late_files_isolated_and_same_page_replacement_untouched() {
    let (_paths, mut store, vault, epoch, old) = dispatched("abandoned");
    vault
        .stage(&binding(&old), &solid_png(2, 2, [9, 9, 9]))
        .unwrap();
    store
        .mark_outcome_unknown(epoch, "r1", "a1", "synthetic disconnect")
        .unwrap();
    let abandoned = store.abandon_unresolved("r1", true).unwrap();
    let replacement = store
        .enqueue(batch("b2", &[("r2", "a2", "s1")]))
        .unwrap()
        .jobs
        .remove(0);

    assert!(store.recover_png_result(&vault, epoch, "r1", "a1").is_err());
    assert_eq!(store.get_job("r1").unwrap(), Some(abandoned));
    assert_eq!(store.get_job("r2").unwrap(), Some(replacement.clone()));
    assert_eq!(replacement.status, JobStatus::Queued);
    assert_eq!(replacement.result, None);
    assert_eq!(result_events(&store, "r1"), 0);
}
