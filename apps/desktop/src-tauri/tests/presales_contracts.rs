use digital_twin_desktop_lib::presales::{
    bundled_skill_metadata, native_value_hash, validate_pair, PresalesDraftPair,
    NATIVE_VALUE_HASH_ALGORITHM,
};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/presales/native-contract.json"
    ))
    .expect("synthetic fixture is valid JSON")
}

fn pair() -> PresalesDraftPair {
    serde_json::from_value(fixture()["pair"].clone()).expect("fixture pair matches request")
}

fn assert_rejected(pair: &PresalesDraftPair, analysis: &Value) {
    assert!(validate_pair(pair, analysis).is_err());
}

fn add_second_page(pair: &mut PresalesDraftPair) {
    let outline = pair.outline.as_object_mut().unwrap();
    let slide = outline["outline"]["slides"][0].clone();
    let mut slide = slide.as_object().unwrap().clone();
    slide.insert("id".into(), json!("scenario-2"));
    slide.insert("title".into(), json!("Review handoff"));
    outline["outline"]["slides"]
        .as_array_mut()
        .unwrap()
        .push(Value::Object(slide));
    let page = outline["plan"]["pages"][0].clone();
    let mut page = page.as_object().unwrap().clone();
    page.insert("slideId".into(), json!("scenario-2"));
    outline["plan"]["pages"]
        .as_array_mut()
        .unwrap()
        .push(Value::Object(page));

    let details = pair.details.as_mut().unwrap().as_object_mut().unwrap();
    let spec = details["specs"][0].clone();
    let mut spec = spec.as_object().unwrap().clone();
    spec.insert("id".into(), json!("scenario-2"));
    spec.insert("title".into(), json!("Review handoff"));
    details["specs"]
        .as_array_mut()
        .unwrap()
        .push(Value::Object(spec));
    let design = details["designs"][0].clone();
    let mut design = design.as_object().unwrap().clone();
    design.insert("slideId".into(), json!("scenario-2"));
    details["designs"]
        .as_array_mut()
        .unwrap()
        .push(Value::Object(design));
}

#[test]
fn accepts_outline_only_and_rich_details_pairs() {
    let source = fixture();
    let mut draft = pair();
    let details = draft.details.take();
    validate_pair(&draft, &source["analysis"]).expect("outline-only pair is valid");
    draft.details = details;
    validate_pair(&draft, &source["analysis"]).expect("rich pair is valid");
}

#[test]
fn request_roundtrip_and_hash_identity_are_deterministic() {
    let original = pair();
    let encoded = serde_json::to_value(&original).unwrap();
    let decoded: PresalesDraftPair = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(decoded, original);
    assert_eq!(NATIVE_VALUE_HASH_ALGORITHM, "native-json-sha256-v1");
    assert_eq!(
        native_value_hash(&encoded).unwrap(),
        native_value_hash(
            &serde_json::from_str(&serde_json::to_string(&encoded).unwrap()).unwrap()
        )
        .unwrap()
    );

    let left = json!({"z": [3, 2, 1], "a": {"second": true, "first": "same"}});
    let right: Value =
        serde_json::from_str(r#"{"a":{"first":"same","second":true},"z":[3,2,1]}"#).unwrap();
    assert_eq!(
        native_value_hash(&left).unwrap(),
        native_value_hash(&right).unwrap()
    );
    assert_eq!(
        native_value_hash(&left).unwrap(),
        "563f9bc0d74b5b1d21929f9826d7debae191aeeb43c8cb08766ee856a0b5dc0d"
    );
    assert_ne!(
        native_value_hash(&json!([1, 2])).unwrap(),
        native_value_hash(&json!([2, 1])).unwrap()
    );
    assert_ne!(
        native_value_hash(&json!("é")).unwrap(),
        native_value_hash(&json!("e\u{301}")).unwrap()
    );
}

#[test]
fn content_plan_and_notes_changes_have_distinct_identities() {
    let draft = pair();
    let original = native_value_hash(&serde_json::to_value(&draft).unwrap()).unwrap();
    for pointer in [
        "/outline/outline/title",
        "/outline/plan/pages/0/keyMessage",
        "/details/designs/0/speakerNotes",
    ] {
        let mut changed = serde_json::to_value(&draft).unwrap();
        *changed.pointer_mut(pointer).unwrap() = json!("changed");
        assert_ne!(native_value_hash(&changed).unwrap(), original, "{pointer}");
    }
}

#[test]
fn request_and_nested_unknown_fields_are_rejected() {
    let mut raw = fixture()["pair"].clone();
    raw.as_object_mut()
        .unwrap()
        .insert("approved".into(), json!(true));
    assert!(serde_json::from_value::<PresalesDraftPair>(raw).is_err());

    let source = fixture();
    let mut draft = pair();
    draft.outline["plan"]["modules"][0]
        .as_object_mut()
        .unwrap()
        .insert("hash".into(), json!("fake"));
    assert_rejected(&draft, &source["analysis"]);
}

#[test]
fn rejects_mismatched_page_ids_order_titles_and_counts() {
    let source = fixture();
    let mut id = pair();
    id.details.as_mut().unwrap()["specs"][0]["id"] = json!("wrong-id");
    assert_rejected(&id, &source["analysis"]);

    let mut order = pair();
    add_second_page(&mut order);
    order.details.as_mut().unwrap()["specs"]
        .as_array_mut()
        .unwrap()
        .reverse();
    order.details.as_mut().unwrap()["designs"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_rejected(&order, &source["analysis"]);

    let mut title = pair();
    title.details.as_mut().unwrap()["specs"][0]["title"] = json!("Other title");
    assert_rejected(&title, &source["analysis"]);

    let mut count = pair();
    count.details.as_mut().unwrap()["designs"] = json!([]);
    assert_rejected(&count, &source["analysis"]);
}

#[test]
fn rejects_uncovered_modules_and_incomplete_relationship_pages() {
    let source = fixture();
    let mut uncovered = pair();
    uncovered.outline["plan"]["modules"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "module-security", "name": "Security", "findingIds": ["finding-security"]
        }));
    assert_rejected(&uncovered, &source["analysis"]);

    let mut architecture = pair();
    architecture.outline["plan"]["pages"][0]["pageType"] = json!("architecture");
    assert_rejected(&architecture, &source["analysis"]);
}

#[test]
fn validates_analysis_before_accepting_evidence_references() {
    let source = fixture();
    for pointer in [
        "/outline/outline/slides/0/sourceIds/0",
        "/outline/outline/slides/0/findingIds/0",
        "/outline/outline/slides/0/dataPointIds/0",
        "/outline/plan/modules/0/findingIds/0",
        "/details/specs/0/sourceMap/0/sourceId",
        "/details/specs/0/findingIds/0",
        "/details/specs/0/dataPointIds/0",
    ] {
        let mut raw = serde_json::to_value(pair()).unwrap();
        *raw.pointer_mut(pointer).unwrap() = json!("missing-id");
        let changed: PresalesDraftPair = serde_json::from_value(raw).unwrap();
        assert_rejected(&changed, &source["analysis"]);
    }

    let mut malformed = source["analysis"].clone();
    malformed["findings"][0]
        .as_object_mut()
        .unwrap()
        .insert("approved".into(), json!(true));
    assert_rejected(&pair(), &malformed);
    let mut dangling = source["analysis"].clone();
    dangling["findings"][0]["sourceIds"][0] = json!("source-missing");
    assert_rejected(&pair(), &dangling);
}

#[test]
fn every_visible_leaf_requires_one_stable_binding() {
    let source = fixture();
    let mut unbound = pair();
    unbound.details.as_mut().unwrap()["designs"][0]["textBindings"]
        .as_array_mut()
        .unwrap()
        .pop();
    assert_rejected(&unbound, &source["analysis"]);

    for field in ["id", "path"] {
        let mut duplicate = pair();
        let bindings = duplicate.details.as_mut().unwrap()["designs"][0]["textBindings"]
            .as_array_mut()
            .unwrap();
        bindings[1][field] = bindings[0][field].clone();
        assert_rejected(&duplicate, &source["analysis"]);
    }

    for path in [
        "/missing",
        "/speakerNotes",
        "/imageGenerationBrief",
        "/shapes/0/x",
    ] {
        let mut unsupported = pair();
        unsupported.details.as_mut().unwrap()["designs"][0]["textBindings"][0]["path"] =
            json!(path);
        assert_rejected(&unsupported, &source["analysis"]);
    }
}

#[test]
fn rejects_invalid_scene_edges_modules_and_binding_references() {
    let source = fixture();
    let mut edge = pair();
    edge.details.as_mut().unwrap()["designs"][0]["scene"]["edges"][0]["to"] = json!("step-missing");
    assert_rejected(&edge, &source["analysis"]);

    let mut self_edge = pair();
    self_edge.details.as_mut().unwrap()["designs"][0]["scene"]["edges"][0]["to"] = json!("step-1");
    assert_rejected(&self_edge, &source["analysis"]);

    let mut duplicate_edge = pair();
    let repeated =
        duplicate_edge.details.as_ref().unwrap()["designs"][0]["scene"]["edges"][0].clone();
    duplicate_edge.details.as_mut().unwrap()["designs"][0]["scene"]["edges"]
        .as_array_mut()
        .unwrap()
        .push(repeated);
    assert_rejected(&duplicate_edge, &source["analysis"]);

    let mut module = pair();
    module.details.as_mut().unwrap()["designs"][0]["scene"]["steps"][0]["moduleId"] =
        json!("module-missing");
    assert_rejected(&module, &source["analysis"]);

    let mut reference = pair();
    reference.details.as_mut().unwrap()["designs"][0]["scene"]["steps"][0]["responseRef"] =
        json!("binding-missing");
    assert_rejected(&reference, &source["analysis"]);
}

#[test]
fn rejects_invalid_shapes_and_table_or_chart_dimensions() {
    let source = fixture();
    for value in [json!(-1), json!("1")] {
        let mut shape = pair();
        shape.details.as_mut().unwrap()["specs"][0]["shapes"][0]["x"] = value;
        assert_rejected(&shape, &source["analysis"]);
    }
    let mut table = pair();
    table.details.as_mut().unwrap()["specs"][0]["tables"][0]["rows"][0]
        .as_array_mut()
        .unwrap()
        .pop();
    assert_rejected(&table, &source["analysis"]);
    let mut chart = pair();
    chart.details.as_mut().unwrap()["specs"][0]["charts"][0]["series"][0]["values"]
        .as_array_mut()
        .unwrap()
        .pop();
    assert_rejected(&chart, &source["analysis"]);
}

#[test]
fn enforces_depth_string_collection_and_envelope_bounds() {
    let source = fixture();
    let mut long = pair();
    long.details.as_mut().unwrap()["designs"][0]["speakerNotes"] = json!("😀".repeat(10_001));
    assert_rejected(&long, &source["analysis"]);

    let mut many = pair();
    many.outline["plan"]["modules"] = Value::Array(
        (0..101)
            .map(|index| {
                json!({
                    "id": format!("module-{index}"), "name": "Module", "findingIds": []
                })
            })
            .collect(),
    );
    assert_rejected(&many, &source["analysis"]);

    let mut pages = pair();
    let slide = pages.outline["outline"]["slides"][0].clone();
    pages.outline["outline"]["slides"] = Value::Array(
        (0..101)
            .map(|index| {
                let mut slide = slide.as_object().unwrap().clone();
                slide.insert("id".into(), json!(format!("slide-{index}")));
                Value::Object(slide)
            })
            .collect(),
    );
    assert_rejected(&pages, &source["analysis"]);

    let mut bindings = pair();
    let binding = bindings.details.as_ref().unwrap()["designs"][0]["textBindings"][0].clone();
    bindings.details.as_mut().unwrap()["designs"][0]["textBindings"] =
        Value::Array(vec![binding; 101]);
    assert_rejected(&bindings, &source["analysis"]);

    let mut steps = pair();
    let step = steps.details.as_ref().unwrap()["designs"][0]["scene"]["steps"][0].clone();
    steps.details.as_mut().unwrap()["designs"][0]["scene"]["steps"] = Value::Array(vec![step; 101]);
    assert_rejected(&steps, &source["analysis"]);

    let mut edges = pair();
    let edge = edges.details.as_ref().unwrap()["designs"][0]["scene"]["edges"][0].clone();
    edges.details.as_mut().unwrap()["designs"][0]["scene"]["edges"] = Value::Array(vec![edge; 401]);
    assert_rejected(&edges, &source["analysis"]);

    let mut too_large = pair();
    too_large
        .outline
        .as_object_mut()
        .unwrap()
        .insert("padding".into(), json!("x".repeat(2 * 1024 * 1024)));
    assert_rejected(&too_large, &source["analysis"]);

    let mut nested = json!(null);
    for _ in 0..34 {
        nested = json!({"next": nested});
    }
    let mut too_deep = pair();
    too_deep
        .outline
        .as_object_mut()
        .unwrap()
        .insert("nested".into(), nested);
    assert_rejected(&too_deep, &source["analysis"]);
}

#[test]
fn bundled_metadata_matches_the_compiler_contract() {
    let metadata = bundled_skill_metadata();
    assert_eq!(metadata["id"], "presales-ppt");
    assert_eq!(metadata["version"], "1.0.0");
    assert_eq!(metadata["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(metadata.as_object().unwrap().len(), 3);
}
