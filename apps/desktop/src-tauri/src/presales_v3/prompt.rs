use super::*;
use crate::presales_queue::{ImageReference, QueueTarget};
use serde_json::{json, Map, Value};

const POLICY: &str = include_str!("../../../../worker/src/presales/visual-prompt.contract.json");
const SKILL: &str = include_str!("../../../../worker/src/presales/skill.bundle.generated.json");

pub(super) fn target(
    snapshot: &V3ProjectSnapshot,
    page: &V3PageState,
    parent_visual: Option<ImageReference>,
    feedback: &str,
) -> Result<QueueTarget, String> {
    let basis = page
        .visual_basis
        .as_ref()
        .ok_or("page has no frozen visual basis")?;
    let policy: Value = serde_json::from_str(POLICY).map_err(super::store::message)?;
    let skill: Value = serde_json::from_str(SKILL).map_err(super::store::message)?;
    if skill["version"].as_str() != Some(&basis.skill.version)
        || skill["sha256"].as_str() != Some(&basis.skill.sha256)
    {
        return Err("frozen page requires a different bundled skill".into());
    }
    let mut prompt = render(
        &page.spec,
        page.design.as_ref().ok_or("page has no approved design")?,
        &snapshot.palette,
        feedback,
        &policy,
        &skill,
    )?;
    if !page.references.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(
            policy["references"]
                .as_str()
                .ok_or("reference policy missing")?,
        );
        prompt.push('\n');
        prompt.push_str(
            &serde_json::to_string_pretty(&page.references).map_err(super::store::message)?,
        );
    }
    Ok(QueueTarget {
        project_id: snapshot.summary.project_id.clone(),
        slide_id: page.slide_id.clone(),
        spec: basis.spec.clone(),
        design: basis.design.clone(),
        skill: basis.skill.clone(),
        palette: basis.palette.clone(),
        parent_visual,
        references: page.references.iter().map(|r| r.image.clone()).collect(),
        reference_context: page.references.clone(),
        prompt_version: policy["version"]
            .as_str()
            .ok_or("missing prompt policy version")?
            .into(),
        prompt,
        feedback: trim_feedback(feedback).into(),
    })
}

fn project(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone())))
            .collect::<Map<_, _>>(),
    )
}

fn render(
    spec: &Value,
    design: &Value,
    style: &crate::visual_style::VisualStyleState,
    feedback: &str,
    policy: &Value,
    skill: &Value,
) -> Result<String, String> {
    let mut visible = project(spec, &["title", "body"]);
    for (field, keys) in [
        ("tables", vec!["headers", "rows"]),
        ("charts", vec!["type", "categories", "series"]),
        ("shapes", vec!["type", "x", "y", "w", "h", "text"]),
    ] {
        visible[field] = Value::Array(
            spec[field]
                .as_array()
                .ok_or("invalid frozen visible content")?
                .iter()
                .map(|v| project(v, &keys))
                .collect(),
        );
    }
    let project_style = style.profile.as_ref().map(|p| json!({"primaryColor":p.primary_color,"backgroundColor":p.background_color,"textColor":p.text_color,"accentColors":p.accent_colors,"instructions":p.instructions}));
    let payload = json!({"approvedSlideSpec":visible,"approvedDesign":project(design,&["slideId","layout","visualFocus","textBindings","scene"]),
        "presalesSkill":project(skill,&["id","version","sha256"]),"projectStyle":project_style,"userFeedback":trim_feedback(feedback)});
    let mut sections = vec![
        policy["opening"]
            .as_str()
            .ok_or("invalid prompt policy")?
            .to_owned(),
        skill["stages"]["visual"]
            .as_str()
            .ok_or("invalid compiled visual skill")?
            .to_owned(),
    ];
    for key in [
        "content",
        "design",
        "feedback",
        if project_style.is_some() {
            "confirmedPalette"
        } else {
            "defaultPalette"
        },
        "output",
    ] {
        sections.push(
            policy[key]
                .as_str()
                .ok_or("invalid prompt instruction")?
                .into(),
        );
    }
    sections.push(serde_json::to_string_pretty(&payload).map_err(super::store::message)?);
    Ok(sections.join("\n\n"))
}

fn trim_feedback(feedback: &str) -> &str {
    // Match ECMAScript String.trim: BOM is whitespace, but NEL is not.
    feedback.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_prompt_matches_independent_shared_golden_projection_and_instruction_sections() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../../fixtures/presales/visual-prompt-golden.json"
        ))
        .unwrap();
        let policy: Value = serde_json::from_str(POLICY).unwrap();
        let skill: Value = serde_json::from_str(SKILL).unwrap();
        let prompt = render(
            &golden["spec"],
            &golden["design"],
            &serde_json::from_value(golden["style"].clone()).unwrap(),
            golden["feedback"].as_str().unwrap(),
            &policy,
            &skill,
        )
        .unwrap();
        let payload: Value =
            serde_json::from_str(&format!("{{{}", prompt.rsplit_once("\n\n{").unwrap().1)).unwrap();
        let mut expected = golden["expectedPayload"].clone();
        expected["presalesSkill"] = crate::presales::bundled_skill_metadata();
        assert_eq!(payload, expected);
        for fragment in golden["instructionFragments"].as_array().unwrap() {
            assert!(prompt.contains(fragment.as_str().unwrap()));
        }
        assert!(!prompt.contains("SECRET"));
        assert!(prompt.contains(skill["stages"]["visual"].as_str().unwrap()));
    }
}
