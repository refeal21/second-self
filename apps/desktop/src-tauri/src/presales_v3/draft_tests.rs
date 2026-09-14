use super::*;

pub(super) fn imported(f: &Fixture, s: &V3WorkbenchService) -> V3ImportedDraft {
    let p = prepare(s, f, LegacyCopyMode::PresalesContentRevision);
    let V3WorkbenchProject::Draft(d) = s.publish_legacy_copy(&p.preparation_id).unwrap() else {
        panic!()
    };
    d
}

#[test]
fn real_pairs_require_joint_review_and_promote_with_original_analysis_identity() {
    let f = Fixture::new(10);
    let s = f.service();
    let original = imported(&f, &s);
    let id = &original.summary.project_id;
    assert!(s.promote_draft(id, 1).is_err());
    let mut outline = f.pair["outline"].clone();
    outline["outline"]["slides"][0]["id"] = json!("new-page");
    outline["plan"]["pages"][0]["slideId"] = json!("new-page");
    let mut added = outline["outline"]["slides"][0].clone();
    added["id"] = json!("second-new-page");
    outline["outline"]["slides"]
        .as_array_mut()
        .unwrap()
        .push(added);
    let mut added = outline["plan"]["pages"][0].clone();
    added["slideId"] = json!("second-new-page");
    outline["plan"]["pages"].as_array_mut().unwrap().push(added);
    let saved = s
        .save_draft_pair(SaveDraftPair {
            project_id: id.clone(),
            expected_revision: 1,
            stage: V3TextStage::Outline,
            envelope: outline.clone(),
        })
        .unwrap();
    assert_eq!(saved.summary.revision, 2);
    assert!(saved
        .authored
        .as_ref()
        .unwrap()
        .checkpoint
        .as_ref()
        .unwrap()
        .approval_bindings
        .is_empty());
    assert!(s
        .save_draft_pair(SaveDraftPair {
            project_id: id.clone(),
            expected_revision: 1,
            stage: V3TextStage::Outline,
            envelope: outline.clone()
        })
        .is_err());
    let mut details = f.pair["details"].clone();
    details["specs"][0]["id"] = json!("new-page");
    details["designs"][0]["slideId"] = json!("new-page");
    let mut added = details["specs"][0].clone();
    added["id"] = json!("second-new-page");
    details["specs"].as_array_mut().unwrap().push(added);
    let mut added = details["designs"][0].clone();
    added["slideId"] = json!("second-new-page");
    details["designs"].as_array_mut().unwrap().push(added);
    assert!(s
        .save_draft_pair(SaveDraftPair {
            project_id: id.clone(),
            expected_revision: 2,
            stage: V3TextStage::Details,
            envelope: details.clone()
        })
        .is_err());
    let approved = s.approve_draft_pair(id, 2, V3TextStage::Outline).unwrap();
    assert_eq!(approved.summary.revision, 3);
    assert!(s
        .save_draft_pair(SaveDraftPair {
            project_id: id.clone(),
            expected_revision: 3,
            stage: V3TextStage::Outline,
            envelope: outline
        })
        .is_err());
    s.save_draft_pair(SaveDraftPair {
        project_id: id.clone(),
        expected_revision: 3,
        stage: V3TextStage::Details,
        envelope: details,
    })
    .unwrap();
    assert!(s.promote_draft(id, 4).is_err());
    s.approve_draft_pair(id, 4, V3TextStage::Details).unwrap();
    drop(s);
    let s = f.service();
    let reopened = s.load_v3_project(id).unwrap();
    assert_eq!(reopened.summary().revision, 5);
    let frozen = s.promote_draft(id, 5).unwrap();
    assert_eq!(frozen.origin, original.origin);
    assert_eq!(frozen.summary.project_id, *id);
    assert_eq!(frozen.summary.revision, 6);
    assert_eq!(frozen.pages[0].slide_id, "new-page");
    assert_eq!(frozen.pages.len(), 2);
    assert_eq!(frozen.pages[1].slide_id, "second-new-page");
    assert!(frozen.pages[0].versions.is_empty());
    assert!(frozen.pages[0].approval.is_none());
    let V3FrozenEvidence::Authored(evidence) = &frozen.frozen_checkpoint else {
        panic!("not authored evidence")
    };
    assert_eq!(evidence.origin.analysis, original.analysis);
    assert_eq!(evidence.origin.comparison_pages, original.comparison_pages);
    assert_eq!(evidence.origin.origin.source_project_id, f.id);
    drop(s);
    assert_eq!(
        f.service().load_v3_project(id).unwrap(),
        V3WorkbenchProject::Frozen(frozen)
    );
}

#[test]
fn invalid_half_and_atomic_promotion_failure_leave_complete_prior_draft() {
    let f = Fixture::new(5);
    let s = f.service();
    let d = imported(&f, &s);
    let id = &d.summary.project_id;
    let mut invalid = f.pair["outline"].clone();
    invalid["plan"]["pages"][0]["slideId"] = json!("wrong-page");
    assert!(s
        .save_draft_pair(SaveDraftPair {
            project_id: id.clone(),
            expected_revision: 1,
            stage: V3TextStage::Outline,
            envelope: invalid
        })
        .is_err());
    assert_eq!(
        s.load_v3_project(id).unwrap(),
        V3WorkbenchProject::Draft(d.clone())
    );
    s.save_draft_pair(SaveDraftPair {
        project_id: id.clone(),
        expected_revision: 1,
        stage: V3TextStage::Outline,
        envelope: f.pair["outline"].clone(),
    })
    .unwrap();
    s.approve_draft_pair(id, 2, V3TextStage::Outline).unwrap();
    s.save_draft_pair(SaveDraftPair {
        project_id: id.clone(),
        expected_revision: 3,
        stage: V3TextStage::Details,
        envelope: f.pair["details"].clone(),
    })
    .unwrap();
    s.approve_draft_pair(id, 4, V3TextStage::Details).unwrap();
    let before = s.load_v3_project(id).unwrap();
    let c = rusqlite::Connection::open(f.root.path().join("presales-v3.sqlite3")).unwrap();
    c.execute_batch("CREATE TRIGGER reject_promotion BEFORE INSERT ON v3_pages BEGIN SELECT RAISE(ABORT,'synthetic promotion failure'); END").unwrap();
    assert!(s
        .promote_draft(id, 5)
        .unwrap_err()
        .contains("synthetic promotion failure"));
    assert_eq!(s.load_v3_project(id).unwrap(), before);
    assert_eq!(
        c.query_row("SELECT count(*) FROM v3_projects", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    c.execute_batch("DROP TRIGGER reject_promotion").unwrap();
    s.promote_draft(id, 5).unwrap();
}

#[test]
fn destination_settings_supply_missing_manual_palette_without_rewriting_origin_and_invalidate_unapproved_pair(
) {
    let f = Fixture::new(5);
    let legacy = rusqlite::Connection::open(f.root.path().join("legacy.sqlite3")).unwrap();
    legacy
        .execute("DELETE FROM visual_style_versions", [])
        .unwrap();
    let s = f.service();
    let d = imported(&f, &s);
    let id = &d.summary.project_id;
    assert!(d.palette.profile.is_none());
    s.save_draft_pair(SaveDraftPair {
        project_id: id.clone(),
        expected_revision: 1,
        stage: V3TextStage::Outline,
        envelope: f.pair["outline"].clone(),
    })
    .unwrap();
    let profile=serde_json::from_value(json!({"primaryColor":"#123456","backgroundColor":"#FFFFFF","textColor":"#000000","accentColors":[],"instructions":"Manual user palette","template":null})).unwrap();
    let settings = SaveDraftSettings {
        project_id: id.clone(),
        expected_revision: 2,
        brief: "Destination brief".into(),
        context: DraftPromptContext {
            task_brief: "New scope".into(),
            source_instructions: Default::default(),
            outline_requirements: "New pages".into(),
        },
        manual_palette: Some(profile),
    };
    let changed = s.save_draft_settings(settings.clone()).unwrap();
    assert_eq!(changed.summary.revision, 3);
    assert!(changed.authored.as_ref().unwrap().checkpoint.is_none());
    assert_eq!(changed.palette, d.palette);
    assert_eq!(changed.brief, d.brief);
    assert_eq!(
        changed.authored.as_ref().unwrap().settings.brief,
        "Destination brief"
    );
    assert!(s.save_draft_settings(settings.clone()).is_err());
    s.save_draft_pair(SaveDraftPair {
        project_id: id.clone(),
        expected_revision: 3,
        stage: V3TextStage::Outline,
        envelope: f.pair["outline"].clone(),
    })
    .unwrap();
    s.approve_draft_pair(id, 4, V3TextStage::Outline).unwrap();
    let mut frozen = settings;
    frozen.expected_revision = 5;
    assert!(s.save_draft_settings(frozen).is_err());
    s.save_draft_pair(SaveDraftPair {
        project_id: id.clone(),
        expected_revision: 5,
        stage: V3TextStage::Details,
        envelope: f.pair["details"].clone(),
    })
    .unwrap();
    s.approve_draft_pair(id, 6, V3TextStage::Details).unwrap();
    let promoted = s.promote_draft(id, 7).unwrap();
    assert_eq!(promoted.palette.profile.unwrap().primary_color, "#123456");
    assert_eq!(promoted.origin, d.origin);
}
