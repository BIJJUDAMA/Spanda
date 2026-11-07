use crate::audio::{service::CaptureService, snapshot::CaptureSnapshot, types::CaptureError};
use std::sync::Arc;

fn task_error(error: impl std::fmt::Display) -> CaptureError {
    CaptureError {
        code: "command_worker".into(),
        message: format!("Capture command failed: {error}. Please restart Spanda."),
    }
}

#[tauri::command]
pub async fn start_capture(
    service: tauri::State<'_, Arc<CaptureService>>,
) -> Result<(), CaptureError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.start())
        .await
        .map_err(task_error)?
}
#[tauri::command]
pub async fn stop_capture(
    service: tauri::State<'_, Arc<CaptureService>>,
) -> Result<(), CaptureError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.stop())
        .await
        .map_err(task_error)?
}
#[tauri::command]
pub async fn get_snapshot(
    service: tauri::State<'_, Arc<CaptureService>>,
) -> Result<CaptureSnapshot, CaptureError> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.snapshot())
        .await
        .map_err(task_error)
}
