//! Selection authority originates in the AppKit completion callback only.
use super::*;
use crate::presales_queue::ReferencePurpose;
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PickPageReference {
    pub project_id: String,
    pub slide_id: String,
    pub expected_revision: i64,
    pub purpose: ReferencePurpose,
}

pub(super) fn complete_selection(
    service: &V3WorkbenchService,
    input: PickPageReference,
    selection: Option<PathBuf>,
) -> Result<Option<V3PageState>, String> {
    let Some(path) = selection else {
        return Ok(None);
    };
    let selected = super::reference_assets::native_selected_file(&path)?;
    service
        .attach_page_reference(
            &input.project_id,
            &input.slide_id,
            input.expected_revision,
            selected,
            input.purpose,
        )
        .map(Some)
}

#[tauri::command]
pub(crate) async fn presales_v3_pick_reference(
    window: tauri::Window,
    service: tauri::State<'_, Arc<V3WorkbenchService>>,
    host: tauri::State<'_, Arc<super::runtime_host::QueueSupervisor>>,
    input: PickPageReference,
) -> Result<Option<V3PageState>, String> {
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    if ACTIVE
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("a reference picker is already open".into());
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            ACTIVE.store(false, Ordering::Release);
        }
    }
    let _guard = Guard;
    let selected = select_png(window).await?;
    let service = service.inner().clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || complete_selection(&service, input, selected))
            .await
            .map_err(|e| e.to_string())??;
    if result.is_some() {
        host.wake();
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
async fn select_png(window: tauri::Window) -> Result<Option<PathBuf>, String> {
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::{NSModalResponseCancel, NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::{NSArray, NSString};
    use std::{
        ffi::{CStr, OsStr},
        os::unix::ffi::OsStrExt,
    };
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = sender.try_send(Err("picker is not on the main thread".into()));
                return;
            };
            let panel = NSOpenPanel::openPanel(mtm);
            panel.setCanChooseFiles(true);
            panel.setCanChooseDirectories(false);
            panel.setAllowsMultipleSelection(false);
            let types = NSArray::from_retained_slice(&[NSString::from_str("png")]);
            // UTType's crate is not cached. The filter is cosmetic; the private
            // selected-reference constructor verifies actual bounded PNG bytes.
            #[allow(deprecated)]
            panel.setAllowedFileTypes(Some(&types));
            let selected_panel: Retained<NSOpenPanel> = panel.clone();
            let completion = block2::RcBlock::new(move |response| {
                let result = if response == NSModalResponseCancel {
                    Ok(None)
                } else if response == NSModalResponseOK {
                    let urls = selected_panel.URLs();
                    if urls.count() != 1 {
                        Err("picker must return exactly one file".into())
                    } else {
                        let url = urls.objectAtIndex(0);
                        if !url.isFileURL() {
                            Err("picker returned a non-file URL".into())
                        } else {
                            // NSURL owns this NUL-terminated filesystem representation
                            // for the duration of this callback; copy before returning.
                            let bytes =
                                unsafe { CStr::from_ptr(url.fileSystemRepresentation().as_ptr()) }
                                    .to_bytes();
                            Ok(Some(PathBuf::from(OsStr::from_bytes(bytes))))
                        }
                    }
                } else {
                    Err("native reference picker failed".into())
                };
                let _ = sender.try_send(result);
            });
            panel.beginWithCompletionHandler(&completion);
        })
        .map_err(|e| e.to_string())?;
    receiver
        .recv()
        .await
        .ok_or("native picker completion channel closed")?
}
#[cfg(not(target_os = "macos"))]
async fn select_png(_window: tauri::Window) -> Result<Option<PathBuf>, String> {
    Err("native reference picker is unavailable on this platform".into())
}
