use super::*;

#[test]
fn native_selected_reference_is_copied_exactly_scoped_and_blocks_inflight_changes() {
    let f = Fixture::paired(5);
    let s = f.service();
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let id = s
        .publish_legacy_copy(&p.preparation_id)
        .unwrap()
        .summary()
        .project_id
        .clone();
    let path = f.root.path().join("chosen-watermarked.png");
    let bytes = png(93);
    std::fs::write(&path, &bytes).unwrap();
    let selected = super::super::reference_assets::native_selected_file(
        &std::fs::canonicalize(&path).unwrap(),
    )
    .unwrap();
    let page = s
        .attach_page_reference(
            &id,
            "scenario-1",
            1,
            selected,
            crate::presales_queue::ReferencePurpose::Layout,
        )
        .unwrap();
    assert_eq!(page.revision, 2);
    assert_eq!(page.references.len(), 1);
    let reference = &page.references[0];
    assert_eq!(
        std::fs::read(
            f.root
                .path()
                .join("presales-v3-assets")
                .join(&reference.relative_path)
        )
        .unwrap(),
        bytes
    );
    let mut store = V3Store::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    let job = store
        .enqueue_pages(
            EnqueuePages {
                project_id: id.clone(),
                batch_id: "ref-batch".into(),
                pages: vec![PageRequest {
                    slide_id: "scenario-1".into(),
                    request_id: "ref-image".into(),
                    attempt_id: "ref-attempt".into(),
                    expected_revision: 2,
                    parent_version_id: None,
                    feedback: String::new(),
                }],
            },
            None,
        )
        .unwrap()
        .jobs
        .remove(0);
    assert_eq!(job.target.references, vec![reference.image.clone()]);
    assert_eq!(job.target.reference_context, vec![reference.clone()]);
    assert!(job.target.prompt.contains(&reference.relative_path));
    assert!(job.target.prompt.contains("layout"));
    let mut mismatched = job.target.clone();
    mismatched.reference_context[0].image.sha256 = "f".repeat(64);
    assert!(crate::presales_queue::QueueStore::open_in_memory()
        .unwrap()
        .enqueue(crate::presales_queue::EnqueueBatch {
            batch_id: "mismatched".into(),
            jobs: vec![crate::presales_queue::EnqueueJob {
                request_id: "mismatch".into(),
                attempt_id: "mismatch-attempt".into(),
                target: mismatched
            }]
        })
        .is_err());
    assert!(s.set_page_references(&id, "scenario-1", 3, vec![]).is_err());
    assert_eq!(
        s.load_v3_project(&id).unwrap().pages()[0].references,
        vec![reference.clone()]
    );
}

#[test]
fn selection_rejects_symlink_and_invalid_image_bytes() {
    let root = temp::tempdir().unwrap();
    let path = root.path().join("bad.png");
    std::fs::write(&path, b"not a PNG").unwrap();
    assert!(super::super::reference_assets::native_selected_file(
        &std::fs::canonicalize(&path).unwrap()
    )
    .is_err());
    std::fs::write(&path, png(1)).unwrap();
    let link = root.path().join("link.png");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(super::super::reference_assets::native_selected_file(&link).is_err());
}

#[test]
fn changing_reference_purpose_preserves_history_but_rejects_old_approval_and_adoption() {
    let f = Fixture::paired(5);
    let s = f.service();
    let p = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let id = s
        .publish_legacy_copy(&p.preparation_id)
        .unwrap()
        .summary()
        .project_id
        .clone();
    let path = f.root.path().join("explicit.png");
    std::fs::write(&path, png(17)).unwrap();
    let chosen = super::super::reference_assets::native_selected_file(
        &std::fs::canonicalize(&path).unwrap(),
    )
    .unwrap();
    let page = s
        .attach_page_reference(
            &id,
            "scenario-1",
            1,
            chosen,
            crate::presales_queue::ReferencePurpose::Style,
        )
        .unwrap();
    let vault =
        crate::presales_queue::ResultVault::open(f.root.path().join("presales-v3-assets")).unwrap();
    let mut store = V3Store::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    store
        .enqueue_pages(
            EnqueuePages {
                project_id: id.clone(),
                batch_id: "history-refs".into(),
                pages: vec![PageRequest {
                    slide_id: "scenario-1".into(),
                    request_id: "history-image".into(),
                    attempt_id: "history-attempt".into(),
                    expected_revision: page.revision,
                    parent_version_id: None,
                    feedback: String::new(),
                }],
            },
            None,
        )
        .unwrap();
    let result = super::super::events_tests::ready(&mut store, &vault, "history-image");
    store.commit_result(result, &vault).unwrap();
    let before = store.load_project(&id).unwrap().pages.remove(0);
    let version = before.current_version_id.clone().unwrap();
    let image = before.versions[0].image.clone().unwrap();
    let approval = ApproveVersion {
        project_id: id.clone(),
        slide_id: "scenario-1".into(),
        version_id: version.clone(),
        image_sha256: image.sha256,
        basis: before.visual_basis.clone().unwrap(),
        expected_revision: before.revision,
        content_checked: true,
        visual_checked: true,
    };
    store.approve_version(approval.clone(), &vault).unwrap();
    let approved = store.load_project(&id).unwrap().pages.remove(0);
    let mut refs = approved.references.clone();
    refs[0].purpose = crate::presales_queue::ReferencePurpose::Layout;
    let after = s
        .set_page_references(&id, "scenario-1", approved.revision, refs.clone())
        .unwrap();
    assert!(after.approval.is_none());
    assert_eq!(after.versions, before.versions);
    let mut stale = approval;
    stale.expected_revision = after.revision;
    assert!(store
        .approve_version(stale, &vault)
        .unwrap_err()
        .contains("references"));
    assert!(store
        .adopt_version(
            AdoptVersion {
                project_id: id.clone(),
                slide_id: "scenario-1".into(),
                version_id: version.clone(),
                expected_revision: after.revision
            },
            &vault
        )
        .unwrap_err()
        .contains("references"));
    assert!(store
        .restore_approval(
            AdoptVersion {
                project_id: id.clone(),
                slide_id: "scenario-1".into(),
                version_id: version,
                expected_revision: after.revision
            },
            &vault
        )
        .is_err());
    let other = prepare(&s, &f, LegacyCopyMode::FormatCopy);
    let other_id = s
        .publish_legacy_copy(&other.preparation_id)
        .unwrap()
        .summary()
        .project_id
        .clone();
    assert!(s
        .set_page_references(&other_id, "scenario-1", 1, refs)
        .is_err());
    drop(store);
    drop(s);
    assert_eq!(f.service().load_v3_project(&id).unwrap().pages()[0], after);
}
