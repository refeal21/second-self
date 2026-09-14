//! Five distinct presales pages through paired native freezes and real private
//! Worker processes. PNG output is synthetic, never model-quality evidence.
use super::supervisor_tests::wait_until;
use super::*;
use crate::presales_queue::{JobStatus, ResultVault};
use crate::presales_v3::{runtime_host::QueueSupervisor, supervisor::RuntimeWork};

const PROJECT: &str = "frozen-project";
const SLIDES: [&str; 5] = ["goals", "architecture", "sensing", "response", "scenario"];

fn page(s: &V3WorkbenchService, index: usize) -> V3PageState {
    s.load_v3_project(PROJECT).unwrap().pages()[index].clone()
}

fn approve(s: &V3WorkbenchService, vault: &ResultVault, index: usize) -> V3Approval {
    let p = page(s, index);
    let v = p
        .versions
        .iter()
        .find(|v| Some(&v.version_id) == p.current_version_id.as_ref())
        .unwrap();
    s.store
        .lock()
        .unwrap()
        .approve_version(
            ApproveVersion {
                project_id: PROJECT.into(),
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

fn enqueue(
    s: &V3WorkbenchService,
    vault: &ResultVault,
    index: usize,
    id: &str,
    parent: Option<String>,
) -> crate::presales_queue::QueueJob {
    let p = page(s, index);
    s.store
        .lock()
        .unwrap()
        .enqueue_pages(
            EnqueuePages {
                project_id: PROJECT.into(),
                batch_id: format!("batch-{id}"),
                pages: vec![PageRequest {
                    slide_id: p.slide_id,
                    request_id: id.into(),
                    attempt_id: format!("attempt-{id}"),
                    expected_revision: p.revision,
                    parent_version_id: parent,
                    feedback: format!("合成修订 {id}：突出双模块关系"),
                }],
            },
            Some(vault),
        )
        .unwrap()
        .jobs
        .remove(0)
}

fn child(f: &Fixture, gated: &[&str], release: &Path) -> Command {
    let source: Value = serde_json::from_str(include_str!(
        "../../../../../fixtures/presales/five-page-acceptance.json"
    ))
    .unwrap();
    let path = f.root.path().join("acceptance-child.json");
    let releases = (1..=5)
        .map(|round| {
            (
                format!("revision-{round}"),
                json!(f.root.path().join(format!("release-revision-{round}"))),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    std::fs::write(&path, json!({"png": STANDARD.encode(png(45)), "outline": source["pair"]["outline"],
        "details": source["pair"]["details"], "gatedRequests": gated, "releaseFile": release, "releaseFiles": releases,
        "interruptMarker": f.root.path().join("acceptance-interrupted"), "delayMs": 25}).to_string()).unwrap();
    let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worker");
    let mut c = Command::new("node");
    c.arg("--import")
        .arg(worker.join("node_modules/tsx/dist/loader.mjs"))
        .arg(worker.join("src/presales/runtime-child.test-support.ts"))
        .arg(path);
    c
}

#[test]
fn five_page_acceptance_concurrency_review_revisions_reopen_and_exact_delivery() {
    for limit in [1, 2, 4] {
        eprintln!("acceptance-window: concurrency-{limit}-paired-setup");
        let f = Fixture::new(5);
        let s = std::sync::Arc::new(f.service());
        let (checkpoint, palette) = crate::presales_v3::basis::tests::frozen_presales_acceptance();
        assert_eq!(
            checkpoint
                .presales
                .as_ref()
                .unwrap()
                .approval_bindings
                .len(),
            2
        );
        s.store
            .lock()
            .unwrap()
            .insert_project(
                ValidatedV3ProjectSeed::from_checkpoint(checkpoint, palette.clone()).unwrap(),
            )
            .unwrap();
        assert_eq!(
            s.load_v3_project(PROJECT)
                .unwrap()
                .pages()
                .iter()
                .map(|p| p.slide_id.as_str())
                .collect::<Vec<_>>(),
            SLIDES
        );
        let vault = ResultVault::open(&s.root).unwrap();
        let selected = f.root.path().join("selected-layout.png");
        std::fs::write(&selected, png(93)).unwrap();
        let reference_page = s
            .attach_page_reference(
                PROJECT,
                "architecture",
                1,
                super::super::reference_assets::native_selected_file(
                    &std::fs::canonicalize(selected).unwrap(),
                )
                .unwrap(),
                crate::presales_queue::ReferencePurpose::Layout,
            )
            .unwrap();
        assert_eq!(reference_page.references.len(), 1);
        assert!(page(&s, 0).references.is_empty());
        let pages = s.load_v3_project(PROJECT).unwrap().pages().to_vec();
        let jobs = s
            .store
            .lock()
            .unwrap()
            .enqueue_pages(
                EnqueuePages {
                    project_id: PROJECT.into(),
                    batch_id: "five-pages".into(),
                    pages: pages
                        .iter()
                        .enumerate()
                        .map(|(i, p)| PageRequest {
                            slide_id: p.slide_id.clone(),
                            request_id: format!("initial-{i}"),
                            attempt_id: format!("attempt-{i}"),
                            expected_revision: p.revision,
                            parent_version_id: None,
                            feedback: String::new(),
                        })
                        .collect(),
                },
                Some(&vault),
            )
            .unwrap()
            .jobs;
        assert_eq!(jobs[1].target.reference_context, reference_page.references);
        assert!(jobs
            .iter()
            .enumerate()
            .all(|(i, j)| i == 1 || j.target.references.is_empty()));
        let refs = s
            .resolve_provider_inputs(&RuntimeWork::Image(jobs[1].clone()))
            .unwrap();
        assert_eq!(std::fs::read(&refs.images[0].path).unwrap(), png(93));
        s.set_queue_settings(limit, false).unwrap();
        let release = f.root.path().join("release-initial");
        // One slot must preserve A->B FIFO; with 2/4 slots B completes ahead of A.
        let gates: &[&str] = if limit == 1 {
            &[]
        } else {
            &["initial-0", "initial-2", "initial-3", "initial-4"]
        };
        eprintln!("acceptance-window: concurrency-{limit}-five-images-and-cross-page-review");
        let observed = s.clone();
        let host = QueueSupervisor::start(s.clone(), child(&f, gates, &release), move |_| {
            assert!(observed.queue_snapshot().unwrap().remote_active <= usize::from(limit));
        })
        .unwrap();
        assert!(wait_until(|| page(&s, 1).versions.len() == 1));
        assert!(host.snapshot().unwrap().remote_active <= usize::from(limit));
        if limit > 1 {
            assert!(page(&s, 0).versions.is_empty());
            assert_eq!(s.queue_snapshot().unwrap().jobs[0].status, "running");
            if limit == 4 {
                assert_eq!(s.queue_snapshot().unwrap().jobs[2].status, "running");
            }
        }
        let initial_b = approve(&s, &vault, 1);
        assert_eq!(page(&s, 1).approval, Some(initial_b.clone()));
        assert_eq!(s.load_v3_project(PROJECT).unwrap().pages().len(), 5);
        evidence(&s, &host, limit, "b-approved");
        std::fs::write(&release, b"reviewed B").unwrap();
        assert!(wait_until(|| host.snapshot().unwrap().succeeded == 5));
        for index in [0, 2, 3, 4] {
            approve(&s, &vault, index);
        }
        let original = s.create_delivery_snapshot(PROJECT).unwrap();
        let mut bases = Vec::new();
        eprintln!("acceptance-window: concurrency-{limit}-five-history-revisions");
        for round in 1..=5 {
            let before = page(&s, 1);
            let base = before.current_version_id.clone().unwrap();
            bases.push(base.clone());
            let draft = SaveFeedback {
                project_id: PROJECT.into(),
                slide_id: "architecture".into(),
                base_version_id: Some(base.clone()),
                expected_revision: 0,
                text: format!("第{round}轮：突出双模块关系"),
            };
            s.store
                .lock()
                .unwrap()
                .save_feedback(draft.clone())
                .unwrap();
            let id = format!("revision-{round}");
            let job = enqueue(&s, &vault, 1, &id, Some(base.clone()));
            let image = before
                .versions
                .iter()
                .find(|v| v.version_id == base)
                .unwrap()
                .image
                .clone();
            assert_eq!(job.target.parent_visual, image);
            let inputs = s.resolve_provider_inputs(&RuntimeWork::Image(job)).unwrap();
            assert_eq!(
                inputs
                    .images
                    .iter()
                    .map(|i| i.role.as_str())
                    .collect::<Vec<_>>(),
                ["parent", "layout"]
            );
            assert_eq!(std::fs::read(&inputs.images[0].path).unwrap(), png(45));
            assert!(page(&s, 1).approval.is_none());
            assert!(page(&s, 0).approval.is_some());
            assert!(s.create_delivery_snapshot(PROJECT).is_err());
            // The independent next feedback draft CAS is writable during work.
            host.wake();
            assert!(wait_until(|| s
                .image_lifecycle
                .lock()
                .unwrap()
                .get_job(&id)
                .unwrap()
                .unwrap()
                .status
                == JobStatus::Running));
            s.store
                .lock()
                .unwrap()
                .save_feedback(SaveFeedback {
                    expected_revision: 1,
                    text: format!("第{round}轮：已保存，等待本轮完成"),
                    ..draft
                })
                .unwrap();
            std::fs::write(
                f.root.path().join(format!("release-revision-{round}")),
                b"feedback saved while running",
            )
            .unwrap();
            host.wake();
            assert!(wait_until(|| page(&s, 1).versions.len() == round + 1));
            approve(&s, &vault, 1);
        }
        s.create_delivery_snapshot(PROJECT).unwrap();
        eprintln!("acceptance-window: concurrency-{limit}-restart-and-exact-delivery");
        let saved = s.load_v3_project(PROJECT).unwrap();
        evidence(&s, &host, limit, "five-revisions");
        assert_eq!(saved.pages()[1].feedback_drafts.len(), 5);
        assert_eq!(saved.pages()[1].versions.len(), 6);
        host.shutdown();
        drop(host);
        drop(s);
        let s = std::sync::Arc::new(f.service());
        assert_eq!(s.load_v3_project(PROJECT).unwrap(), saved);
        assert_eq!(
            s.load_v3_project(PROJECT).unwrap().pages()[1]
                .feedback_drafts
                .iter()
                .map(|d| d.base_version_id.clone().unwrap())
                .collect::<std::collections::BTreeSet<_>>(),
            bases.into_iter().collect()
        );
        for v in &page(&s, 1).versions {
            let image = v.image.as_ref().unwrap();
            assert_eq!(
                STANDARD
                    .decode(
                        s.read_verified_image(
                            PROJECT,
                            "architecture",
                            &v.version_id,
                            &image.asset_id,
                            &image.sha256
                        )
                        .unwrap()
                        .base64
                    )
                    .unwrap(),
                png(45)
            );
        }
        // Inspection has no adoption side effect; delivery still chooses revision 6.
        let latest = s.create_delivery_snapshot(PROJECT).unwrap();
        assert_ne!(latest.pages[1].version_id, initial_b.version_id);
        let before = page(&s, 1);
        s.store
            .lock()
            .unwrap()
            .adopt_version(
                AdoptVersion {
                    project_id: PROJECT.into(),
                    slide_id: "architecture".into(),
                    version_id: initial_b.version_id.clone(),
                    expected_revision: before.revision,
                },
                &vault,
            )
            .unwrap();
        let before = page(&s, 1);
        s.store
            .lock()
            .unwrap()
            .restore_approval(
                AdoptVersion {
                    project_id: PROJECT.into(),
                    slide_id: "architecture".into(),
                    version_id: initial_b.version_id.clone(),
                    expected_revision: before.revision,
                },
                &vault,
            )
            .unwrap();
        let exact = s.create_delivery_snapshot(PROJECT).unwrap();
        assert_eq!(exact.pages[1].version_id, initial_b.version_id);
        assert_eq!(exact.pages[1].approval_id, initial_b.approval_id);
        assert_eq!(
            exact.pages[1].content.as_ref().unwrap().spec["title"],
            "感知与处置双模块总体架构"
        );
        for i in [0, 2, 3, 4] {
            assert_eq!(exact.pages[i], original.pages[i]);
        }
        assert_eq!(
            s.load_v3_project(PROJECT).unwrap().pages()[1]
                .versions
                .len(),
            6
        );
        assert_eq!(
            s.store
                .lock()
                .unwrap()
                .load_project(PROJECT)
                .unwrap()
                .palette,
            palette
        );
        // Same five-page project: acknowledged cancellation is unresolved and
        // occupies its slot after actual child/service restart, never auto-resends.
        eprintln!("acceptance-window: concurrency-{limit}-cancel-unknown-restart");
        enqueue(&s, &vault, 0, "uncertain-a", None);
        let held = f.root.path().join("never-release");
        s.set_queue_settings(1, false).unwrap();
        let host =
            QueueSupervisor::start(s.clone(), child(&f, &["uncertain-a"], &held), |_| {}).unwrap();
        assert!(wait_until(|| s
            .image_lifecycle
            .lock()
            .unwrap()
            .get_job("uncertain-a")
            .unwrap()
            .unwrap()
            .provider
            .is_some()));
        s.image_lifecycle
            .lock()
            .unwrap()
            .request_cancel("uncertain-a")
            .unwrap();
        host.interrupt("uncertain-a".into());
        assert!(wait_until(|| f
            .root
            .path()
            .join("acceptance-interrupted")
            .exists()));
        assert_eq!(
            s.image_lifecycle
                .lock()
                .unwrap()
                .get_job("uncertain-a")
                .unwrap()
                .unwrap()
                .status,
            JobStatus::CancelRequested
        );
        assert_eq!(host.snapshot().unwrap().remote_active, 1);
        host.shutdown();
        drop(host);
        drop(s);
        let s = std::sync::Arc::new(f.service());
        let host = QueueSupervisor::start(s.clone(), child(&f, &[], &held), |_| {}).unwrap();
        assert!(wait_until(|| host.snapshot().unwrap().dispatch_available));
        std::thread::sleep(Duration::from_millis(100));
        let uncertain = s
            .image_lifecycle
            .lock()
            .unwrap()
            .get_job("uncertain-a")
            .unwrap()
            .unwrap();
        assert_eq!(uncertain.status, JobStatus::OutcomeUnknown);
        assert!(uncertain.provider.is_some());
        assert_eq!(host.snapshot().unwrap().remote_active, 1);
        assert!(s
            .image_lifecycle
            .lock()
            .unwrap()
            .abandon_unresolved("uncertain-a", false)
            .is_err());
        s.image_lifecycle
            .lock()
            .unwrap()
            .abandon_unresolved("uncertain-a", true)
            .unwrap();
        host.shutdown();
        // Missing resource is explicit and cannot be used as a revision parent.
        let p = page(&s, 1);
        let v = p.versions.first().unwrap();
        let asset = v.image.as_ref().unwrap();
        let job = enqueue(&s, &vault, 1, "missing-parent", Some(v.version_id.clone()));
        let inputs = s
            .resolve_provider_inputs(&RuntimeWork::Image(job.clone()))
            .unwrap();
        let path = &inputs.images[0].path;
        let bytes = std::fs::read(path).unwrap();
        std::fs::remove_file(path).unwrap();
        s.image_lifecycle
            .lock()
            .unwrap()
            .request_cancel("missing-parent")
            .unwrap();
        let current = page(&s, 1);
        assert!(s
            .store
            .lock()
            .unwrap()
            .enqueue_pages(
                EnqueuePages {
                    project_id: PROJECT.into(),
                    batch_id: "missing-parent-retry".into(),
                    pages: vec![PageRequest {
                        slide_id: "architecture".into(),
                        request_id: "missing-parent-retry".into(),
                        attempt_id: "missing-parent-retry-attempt".into(),
                        expected_revision: current.revision,
                        parent_version_id: Some(v.version_id.clone()),
                        feedback: String::new()
                    }],
                },
                Some(&vault)
            )
            .is_err());
        assert!(s
            .read_verified_image(
                PROJECT,
                "architecture",
                &v.version_id,
                &asset.asset_id,
                &asset.sha256
            )
            .is_err());
        assert!(s.resolve_provider_inputs(&RuntimeWork::Image(job)).is_err());
        std::fs::write(path, bytes).unwrap();
        eprintln!("acceptance: concurrency={limit}; five distinct pages; five parent edits; reopen/history/delivery; cancellation uncertainty; missing resource");
    }
}

// Optional, test-owned DTO evidence for the no-network real-App browser harness.
fn evidence(s: &V3WorkbenchService, host: &QueueSupervisor, limit: u8, label: &str) {
    if let Ok(directory) = std::env::var("PRESALES_ACCEPTANCE_EVIDENCE_DIR") {
        let directory = PathBuf::from(directory);
        assert!(directory.is_absolute());
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(format!("concurrency-{limit}-{label}.json")),
            serde_json::to_vec_pretty(&json!({"project": s.load_v3_project(PROJECT).unwrap(), "queue": host.snapshot().unwrap()})).unwrap()).unwrap();
    }
}
