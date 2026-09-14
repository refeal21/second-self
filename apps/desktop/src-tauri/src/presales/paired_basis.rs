//! Pure pair evidence shared by the unchanged legacy adapter and authored V3.
use super::*;
use serde_json::Value;

pub(crate) fn derive_pair_basis(
    analysis: &Value,
    request_id: &str,
    artifact_sha256: &str,
    outline_version: &str,
    details_version: Option<&str>,
    pair: &PresalesDraftPair,
) -> Result<PresalesBasis, String> {
    validate_pair(pair, analysis)?;
    if pair.details.is_some() != details_version.is_some() {
        return Err("details version and complete pair must agree".into());
    }
    let mut bindings = vec![];
    let details = pair
        .details
        .as_ref()
        .map(|d| {
            for (spec, design) in d["specs"]
                .as_array()
                .ok_or("specs missing")?
                .iter()
                .zip(d["designs"].as_array().ok_or("designs missing")?)
            {
                for binding in design["textBindings"]
                    .as_array()
                    .ok_or("bindings missing")?
                {
                    let path = binding["path"].as_str().ok_or("binding path missing")?;
                    bindings.push(VisibleBindingBasis {
                        slide_id: spec["id"].as_str().ok_or("slide id missing")?.into(),
                        id: binding["id"].as_str().ok_or("binding id missing")?.into(),
                        path: path.into(),
                        visible_value_hash: native_value_hash(
                            spec.pointer(path).ok_or("binding value missing")?,
                        )?,
                    });
                }
            }
            Ok::<_, String>(DetailsBasis {
                version_id: details_version.ok_or("details version missing")?.into(),
                content_hash: native_value_hash(&d["specs"])?,
                design_hash: native_value_hash(&d["designs"])?,
            })
        })
        .transpose()?;
    Ok(PresalesBasis {
        analysis: AnalysisBasis {
            request_id: request_id.into(),
            artifact_sha256: artifact_sha256.into(),
            output_hash: native_value_hash(analysis)?,
        },
        outline: OutlineBasis {
            version_id: outline_version.into(),
            content_hash: native_value_hash(&pair.outline["outline"])?,
            plan_hash: native_value_hash(&pair.outline["plan"])?,
        },
        details,
        bindings,
    })
}

pub(crate) fn validate_joint_binding(
    checkpoint: &PresalesCheckpoint,
    index: usize,
) -> Result<(), String> {
    let binding = checkpoint
        .approval_bindings
        .get(index)
        .ok_or("joint binding missing")?;
    let (stage, version, content, companion) = if index == 0 {
        (
            "outline_review",
            &checkpoint.basis.outline.version_id,
            &checkpoint.basis.outline.content_hash,
            &checkpoint.basis.outline.plan_hash,
        )
    } else if index == 1 {
        let details = checkpoint
            .basis
            .details
            .as_ref()
            .ok_or("details binding requires details")?;
        (
            "detail_review",
            &details.version_id,
            &details.content_hash,
            &details.design_hash,
        )
    } else {
        return Err("only two ordered joint approvals are permitted".into());
    };
    if binding.stage != stage
        || binding.skill != checkpoint.skill
        || &binding.version_id != version
        || &binding.content_hash != content
        || &binding.companion_hash != companion
        || binding.approval_id.is_empty()
        || chrono::DateTime::parse_from_rfc3339(&binding.decided_at).is_err()
    {
        return Err("paired approval order, skill or exact pair binding is invalid".into());
    }
    Ok(())
}
