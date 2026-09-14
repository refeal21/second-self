//! Typed ID/revision commands. No raw targets, provider replies or file tokens.
use super::*;
use std::sync::Arc;
use tauri::State;
type QueueSupervisor = Arc<super::runtime_host::QueueSupervisor>;
use crate::presales_queue::{EnqueueOutcome, QueueSettings, ResultVault};

async fn run<T: Send + 'static>(
    service: &Arc<V3WorkbenchService>,
    operation: impl FnOnce(&V3WorkbenchService) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let service = service.clone();
    tauri::async_runtime::spawn_blocking(move || operation(&service))
        .await
        .map_err(|e| e.to_string())?
}
async fn change<T: Send + 'static>(
    service: &Arc<V3WorkbenchService>,
    host: &QueueSupervisor,
    operation: impl FnOnce(&V3WorkbenchService) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let result = run(service, operation).await?;
    host.wake();
    Ok(result)
}
#[tauri::command]
pub(crate) async fn presales_v3_list(
    service: State<'_, Arc<V3WorkbenchService>>,
) -> Result<Vec<V3CatalogEntry>, String> {
    run(&service, |s| s.list_project_catalog()).await
}
#[tauri::command]
pub(crate) async fn presales_v3_load(
    service: State<'_, Arc<V3WorkbenchService>>,
    project_id: String,
) -> Result<V3WorkbenchProject, String> {
    run(&service, move |s| s.load_v3_project(&project_id)).await
}
#[tauri::command]
pub(crate) async fn presales_v3_queue(
    host: State<'_, QueueSupervisor>,
) -> Result<super::runtime_callbacks::QueueSnapshot, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.snapshot())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn presales_v3_enqueue(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    input: EnqueuePages,
) -> Result<EnqueueOutcome, String> {
    change(&service, &host, move |s| {
        let vault = ResultVault::open(&s.root)?;
        s.store
            .lock()
            .map_err(|_| "v3 store lock poisoned")?
            .enqueue_pages(input, Some(&vault))
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_settings(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    concurrency: u8,
    paused: bool,
) -> Result<QueueSettings, String> {
    change(&service, &host, move |s| {
        s.set_queue_settings(concurrency, paused)
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_save_pair(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    input: SaveDraftPair,
) -> Result<V3ImportedDraft, String> {
    change(&service, &host, move |s| s.save_draft_pair(input)).await
}
#[tauri::command]
pub(crate) async fn presales_v3_approve_pair(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    project_id: String,
    expected_revision: i64,
    stage: V3TextStage,
) -> Result<V3ImportedDraft, String> {
    change(&service, &host, move |s| {
        s.approve_draft_pair(&project_id, expected_revision, stage)
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_draft_settings(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    input: SaveDraftSettings,
) -> Result<V3ImportedDraft, String> {
    change(&service, &host, move |s| s.save_draft_settings(input)).await
}
#[tauri::command]
pub(crate) async fn presales_v3_promote(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    project_id: String,
    expected_revision: i64,
) -> Result<V3ProjectSnapshot, String> {
    change(&service, &host, move |s| {
        s.promote_draft(&project_id, expected_revision)
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_author(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    input: RequestTextAuthoring,
) -> Result<V3TextOperation, String> {
    change(&service, &host, move |s| s.request_text_authoring(input)).await
}
#[tauri::command]
pub(crate) async fn presales_v3_text_history(
    service: State<'_, Arc<V3WorkbenchService>>,
    project_id: String,
) -> Result<Vec<V3TextOperation>, String> {
    run(&service, move |s| s.list_text_operations(&project_id)).await
}
#[tauri::command]
pub(crate) async fn presales_v3_save_feedback(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    input: SaveFeedback,
) -> Result<V3FeedbackDraft, String> {
    change(&service, &host, move |s| {
        s.store
            .lock()
            .map_err(|_| "v3 store lock poisoned")?
            .save_feedback(input)
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_approve_version(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    input: ApproveVersion,
) -> Result<V3Approval, String> {
    change(&service, &host, move |s| {
        s.store
            .lock()
            .map_err(|_| "v3 store lock poisoned")?
            .approve_version(input, &ResultVault::open(&s.root)?)
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_adopt_version(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    input: AdoptVersion,
) -> Result<V3PageState, String> {
    change(&service, &host, move |s| {
        s.store
            .lock()
            .map_err(|_| "v3 store lock poisoned")?
            .adopt_version(input, &ResultVault::open(&s.root)?)
    })
    .await
}
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkKind {
    Image,
    Text,
}
#[tauri::command]
pub(crate) async fn presales_v3_cancel(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    kind: WorkKind,
    request_id: String,
) -> Result<(), String> {
    let id = request_id.clone();
    change(&service, &host, move |s| {
        match kind {
            WorkKind::Text => {
                s.cancel_text_authoring(&id, false)?;
            }
            WorkKind::Image => {
                s.image_lifecycle
                    .lock()
                    .map_err(|_| "image lifecycle lock poisoned")?
                    .request_cancel(&id)?;
            }
        }
        Ok(())
    })
    .await?;
    host.interrupt(request_id);
    Ok(())
}
#[tauri::command]
pub(crate) async fn presales_v3_abandon(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    kind: WorkKind,
    request_id: String,
    acknowledge_duplicate_risk: bool,
) -> Result<(), String> {
    if !acknowledge_duplicate_risk {
        return Err("explicit duplicate-risk acknowledgement required".into());
    }
    change(&service, &host, move |s| {
        match kind {
            WorkKind::Text => {
                s.cancel_text_authoring(&request_id, true)?;
            }
            WorkKind::Image => {
                s.image_lifecycle
                    .lock()
                    .map_err(|_| "image lifecycle lock poisoned")?
                    .abandon_unresolved(&request_id, true)?;
            }
        }
        Ok(())
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_retry_save(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
) -> Result<(), String> {
    change(&service, &host, |s| s.retry_local_results()).await
}
#[tauri::command]
pub(crate) async fn presales_v3_delivery(
    service: State<'_, Arc<V3WorkbenchService>>,
    project_id: String,
) -> Result<V3DeliverySnapshot, String> {
    run(&service, move |s| s.create_delivery_snapshot(&project_id)).await
}
#[tauri::command]
pub(crate) async fn presales_v3_prepare_copy(
    app: tauri::AppHandle,
    service: State<'_, Arc<V3WorkbenchService>>,
    input: PrepareLegacyCopy,
) -> Result<PreparedLegacyCopySummary, String> {
    use tauri::Manager;
    run(&service, move |s| {
        s.prepare_legacy_copy(&app.state::<crate::workbench::WorkbenchService>(), input)
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_publish_copy(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    preparation_id: String,
) -> Result<V3WorkbenchProject, String> {
    change(&service, &host, move |s| {
        s.publish_legacy_copy(&preparation_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_discard_copy(
    service: State<'_, Arc<V3WorkbenchService>>,
    preparation_id: String,
) -> Result<(), String> {
    run(&service, move |s| s.discard_legacy_copy(&preparation_id)).await
}
#[tauri::command]
pub(crate) async fn presales_v3_restore_approval(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    input: AdoptVersion,
) -> Result<V3PageState, String> {
    change(&service, &host, move |s| {
        s.store
            .lock()
            .map_err(|_| "v3 store lock poisoned")?
            .restore_approval(input, &ResultVault::open(&s.root)?)
    })
    .await
}
#[tauri::command]
pub(crate) async fn presales_v3_set_references(
    service: State<'_, Arc<V3WorkbenchService>>,
    host: State<'_, QueueSupervisor>,
    project_id: String,
    slide_id: String,
    expected_revision: i64,
    references: Vec<crate::presales_queue::ImageReferenceContext>,
) -> Result<V3PageState, String> {
    change(&service, &host, move |s| {
        s.set_page_references(&project_id, &slide_id, expected_revision, references)
    })
    .await
}
