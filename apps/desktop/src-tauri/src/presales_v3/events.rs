use super::store::{bump_project, decode, encode, load_on, message, page_on, write_on};
use super::*;
use crate::presales_queue::{
    store::{enqueue_on, read_batch_outcome, read_jobs},
    EnqueueBatch, EnqueueJob, EnqueueOutcome, JobStatus, ResultVault,
};
use rusqlite::{params, Connection, OptionalExtension};

impl V3Store {
    /// Inputs name saved pages and versions. Native code owns all prompt and image evidence.
    pub fn enqueue_pages(
        &mut self,
        input: EnqueuePages,
        vault: Option<&ResultVault>,
    ) -> Result<EnqueueOutcome, String> {
        let encoded = encode(&input)?;
        if input.pages.is_empty() || input.pages.len() > 100 || encoded.len() > 2 * 1024 * 1024 {
            return Err("admission requires 1..=100 pages within 2 MiB".into());
        }
        {
            let tx = self.connection.unchecked_transaction().map_err(message)?;
            if let Some(outcome) = replay_on(&tx, &input)? {
                tx.commit().map_err(message)?;
                return Ok(outcome);
            }
            tx.commit().map_err(message)?;
        }
        // Resolve byte evidence outside the short write transaction. Every identity
        // is checked again against the transaction's immutable saved versions.
        let snapshot = self.load_project(&input.project_id)?;
        let mut parents = std::collections::HashMap::new();
        for request in &input.pages {
            if let Some(id) = &request.parent_version_id {
                let page = page_on(&snapshot, &request.slide_id)?;
                let image = super::publication::verify_version(
                    &self.connection,
                    page,
                    id,
                    vault.ok_or("parent visual requires native result vault")?,
                )?;
                parents.insert((request.slide_id.clone(), id.clone()), image);
            }
        }
        write_on(&mut self.connection, |tx| {
            if let Some(outcome) = replay_on(tx, &input)? {
                return Ok(outcome);
            }
            let snapshot = load_on(tx, &input.project_id)?;
            let mut ids = std::collections::HashSet::new();
            let mut jobs = Vec::new();
            for request in &input.pages {
                if !ids.insert(&request.slide_id) {
                    return Err("duplicate page in admission".into());
                }
                let page = page_on(&snapshot, &request.slide_id)?;
                let target =
                    if let Some(active) = active_job(tx, &input.project_id, &request.slide_id)? {
                        active.target
                    } else {
                        if page.revision != request.expected_revision {
                            return Err("page revision conflict".into());
                        }
                        let parent = match &request.parent_version_id {
                            None => None,
                            Some(id) => {
                                let version = super::publication::version_on(page, id)?;
                                let image = parents
                                    .get(&(page.slide_id.clone(), id.clone()))
                                    .ok_or("missing verified parent")?;
                                if version.image.as_ref() != Some(image) {
                                    return Err("parent evidence changed".into());
                                }
                                Some(image.clone())
                            }
                        };
                        super::prompt::target(&snapshot, page, parent, &request.feedback)?
                    };
                jobs.push(EnqueueJob {
                    request_id: request.request_id.clone(),
                    attempt_id: request.attempt_id.clone(),
                    target,
                });
            }
            let outcome = enqueue_on(
                tx,
                EnqueueBatch {
                    batch_id: input.batch_id.clone(),
                    jobs,
                },
            )?;
            tx.execute(
                "INSERT INTO v3_admissions (batch_id,input_json) VALUES (?1,?2)",
                params![input.batch_id, encoded],
            )
            .map_err(message)?;
            let mut changed = false;
            for (request, job) in input.pages.iter().zip(&outcome.jobs) {
                if job.request_id != request.request_id {
                    continue;
                }
                let revision = request
                    .expected_revision
                    .checked_add(1)
                    .ok_or("page revision exhausted")?;
                if tx.execute("UPDATE v3_pages SET revision=?1, intent_request_id=?2, approved_version_id=NULL WHERE project_id=?3 AND slide_id=?4 AND revision=?5",
                    params![revision, job.request_id, input.project_id, request.slide_id, request.expected_revision]).map_err(message)? != 1 { return Err("page revision conflict".into()); }
                tx.execute("INSERT INTO v3_intents (request_id, project_id, slide_id, page_revision, target_json) VALUES (?1,?2,?3,?4,?5)",
                    params![job.request_id, input.project_id, request.slide_id, revision, encode(&job.target)?]).map_err(message)?;
                changed = true;
            }
            if changed {
                bump_project(tx, &input.project_id)?;
            }
            Ok(outcome)
        })
    }
}

fn replay_on(
    connection: &Connection,
    input: &EnqueuePages,
) -> Result<Option<EnqueueOutcome>, String> {
    let original = connection
        .query_row(
            "SELECT input_json FROM v3_admissions WHERE batch_id=?1",
            [&input.batch_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(message)?;
    let Some(original) = original else {
        return Ok(None);
    };
    if decode::<EnqueuePages>(&original)? != *input {
        return Err("batch was already admitted with different input".into());
    }
    load_on(connection, &input.project_id)?;
    read_batch_outcome(connection, &input.batch_id).map(Some)
}

pub(super) fn active_job(
    connection: &Connection,
    project_id: &str,
    slide_id: &str,
) -> Result<Option<crate::presales_queue::QueueJob>, String> {
    Ok(read_jobs(connection)?.into_iter().find(|job| {
        job.target.project_id == project_id
            && job.target.slide_id == slide_id
            && matches!(
                job.status,
                JobStatus::Queued
                    | JobStatus::Dispatching
                    | JobStatus::Running
                    | JobStatus::ResultReady
                    | JobStatus::Committing
                    | JobStatus::CancelRequested
                    | JobStatus::OutcomeUnknown
            )
    }))
}
