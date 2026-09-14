use super::*;
use serde_json::{json, Value};
pub(super) fn render(t: &V3TextTarget) -> Result<String, String> {
    let policy: Value = serde_json::from_str(include_str!(
        "../../../../worker/src/presales/authoring-prompt.contract.json"
    ))
    .map_err(store::message)?;
    let skill: Value = serde_json::from_str(include_str!(
        "../../../../worker/src/presales/skill.bundle.generated.json"
    ))
    .map_err(store::message)?;
    let stage = match t.stage {
        V3TextStage::Outline => "outline",
        V3TextStage::Details => "details",
    };
    let context = t.context.clone().unwrap_or_else(
        || json!({"taskBrief":"","sourceInstructions":{},"outlineRequirements":""}),
    );
    let sources = t.sources.iter().map(|s|json!({"sourceId":s.original["id"],"fileName":s.original["fileName"],"relativePath":s.asset.relative_path,
        "instructions":context["sourceInstructions"][s.original["id"].as_str().unwrap_or("")].as_str().unwrap_or("")})).collect::<Vec<_>>();
    let mut input = json!({"project":{"name":t.name,"goal":t.brief},"taskBrief":context["taskBrief"],"sourceFiles":sources,
        "outlineRequirements":context["outlineRequirements"],"currentAnalysis":t.analysis.asset.relative_path,
        "approvedPreferences":t.preferences,"presalesSkill":t.skill});
    if t.stage == V3TextStage::Details {
        let outline = t
            .approved_outline
            .as_ref()
            .ok_or("approved outline pair missing")?;
        input["approvedOutline"] = outline["outline"].clone();
        input["approvedPresalesPlan"] = outline["plan"].clone();
        input["confirmedVisualStyle"] = if t.palette.profile.is_some() {
            serde_json::to_value(&t.palette).map_err(store::message)?
        } else {
            Value::Null
        };
    }
    let contract = policy[format!("{stage}Contract")]
        .as_array()
        .ok_or("paired contract missing")?
        .iter()
        .map(|v| v.as_str().ok_or("invalid paired contract"))
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    let instructions = format!(
        "{}\n\n{}",
        skill["stages"][stage]
            .as_str()
            .ok_or("compiled stage missing")?,
        contract
    );
    let mut parts = vec![
        policy[format!("{stage}Task")]
            .as_str()
            .ok_or("paired task missing")?
            .into(),
        instructions,
        policy["contextPolicy"]
            .as_str()
            .ok_or("context policy missing")?
            .into(),
        policy["contextLabel"]
            .as_str()
            .ok_or("context label missing")?
            .into(),
        serde_json::to_string_pretty(&input).map_err(store::message)?,
    ];
    for tail in policy["tail"].as_array().ok_or("policy tail missing")? {
        parts.push(tail.as_str().ok_or("policy tail invalid")?.into());
    }
    Ok(parts.join("\n"))
}
