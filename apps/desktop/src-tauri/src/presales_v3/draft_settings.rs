use super::*;

pub(super) fn initial(d: &V3ImportedDraft) -> Result<V3DraftSettings, String> {
    Ok(V3DraftSettings {
        brief: d.brief.clone(),
        context: d
            .context
            .clone()
            .map(serde_json::from_value)
            .transpose()
            .map_err(store::message)?
            .unwrap_or_default(),
        palette: d.palette.clone(),
        palette_origin: DraftPaletteOrigin::Imported,
    })
}
pub(super) fn current(d: &V3ImportedDraft) -> Result<V3DraftSettings, String> {
    d.authored
        .as_ref()
        .map(|a| Ok(a.settings.clone()))
        .unwrap_or_else(|| initial(d))
}
pub(super) fn change(
    draft: &V3ImportedDraft,
    brief: &str,
    context: &DraftPromptContext,
    manual: &Option<crate::visual_style::VisualStyleProfile>,
) -> Result<V3DraftSettings, String> {
    if draft
        .authored
        .as_ref()
        .and_then(|a| a.checkpoint.as_ref())
        .is_some_and(|c| !c.approval_bindings.is_empty())
    {
        return Err("settings are frozen after outline joint approval".into());
    }
    if brief.trim().is_empty()
        || brief.len() > 20_000
        || context.task_brief.len() > 20_000
        || context.outline_requirements.len() > 20_000
        || context
            .source_instructions
            .iter()
            .any(|(id, text)| text.len() > 10_000 || !draft.sources.iter().any(|s| s["id"] == *id))
    {
        return Err("draft settings text bounds/source mapping invalid".into());
    }
    let mut settings = current(draft)?;
    settings.brief = brief.into();
    settings.context = context.clone();
    if let Some(profile) = manual {
        crate::visual_style::validate_profile(profile)?;
        if profile.template.is_some() {
            return Err("manual palette cannot claim template-derived authority".into());
        }
        settings.palette = crate::visual_style::VisualStyleState {
            revision: settings
                .palette
                .revision
                .checked_add(1)
                .filter(|n| *n > 0)
                .ok_or("palette revision exhausted")?,
            profile: Some(profile.clone()),
            locked: false,
        };
        settings.palette_origin = DraftPaletteOrigin::Manual;
    }
    Ok(settings)
}

impl V3WorkbenchService {
    pub fn save_draft_settings(&self, input: SaveDraftSettings) -> Result<V3ImportedDraft, String> {
        let at = store::now()?;
        let mut store = self.store.lock().map_err(|_| "v3 store lock poisoned")?;
        store::write_on(&mut store.connection, |tx| {
            super::draft::action_on(
                tx,
                &input.project_id,
                input.expected_revision,
                V3DraftAction::Settings {
                    brief: input.brief.clone(),
                    context: input.context.clone(),
                    manual_palette: input.manual_palette.clone(),
                },
                &at,
            )
        })
    }
}
