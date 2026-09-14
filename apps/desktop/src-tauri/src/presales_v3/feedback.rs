use super::store::{
    decode, encode, load_review_on as load_on, message, now, review_page_on as page_on, write_on,
};
use super::*;
use rusqlite::{params, OptionalExtension};

impl V3Store {
    pub fn save_feedback(&mut self, input: SaveFeedback) -> Result<V3FeedbackDraft, String> {
        if input.text.len() > 16_384 || input.text.contains('\0') || input.expected_revision < 0 {
            return Err("feedback must be at most 16384 bytes without NUL and use a nonnegative draft revision".into());
        }
        let updated_at = now()?;
        write_on(&mut self.connection, |tx| {
            let snapshot = load_on(tx, &input.project_id)?;
            let page = page_on(&snapshot, &input.slide_id)?;
            if let Some(id) = &input.base_version_id {
                super::publication::version_on(page, id)?;
            }
            let key = input.base_version_id.as_deref().unwrap_or("");
            let prior = tx.query_row("SELECT draft_json FROM v3_feedback WHERE project_id=?1 AND slide_id=?2 AND base_version_id=?3",
                params![input.project_id, input.slide_id, key], |r| r.get::<_, String>(0)).optional().map_err(message)?;
            let revision = prior
                .as_deref()
                .map(decode::<V3FeedbackDraft>)
                .transpose()?
                .map_or(0, |d| d.revision);
            if revision != input.expected_revision {
                return Err("feedback draft revision conflict".into());
            }
            let draft = V3FeedbackDraft {
                base_version_id: input.base_version_id.clone(),
                revision: revision.checked_add(1).ok_or("draft revision exhausted")?,
                text: input.text.clone(),
                updated_at: updated_at.clone(),
            };
            tx.execute("INSERT INTO v3_feedback (project_id,slide_id,base_version_id,revision,draft_json) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(project_id,slide_id,base_version_id) DO UPDATE SET revision=excluded.revision,draft_json=excluded.draft_json",
                params![input.project_id, input.slide_id, key, draft.revision, encode(&draft)?]).map_err(message)?;
            // A draft has its own CAS. It changes neither generation intent nor delivery eligibility.
            Ok(draft)
        })
    }
}
