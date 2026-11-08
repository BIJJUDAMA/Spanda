pub mod audio;
mod commands;
mod media;
mod recording;

/// Read-only diagnostic for validating desktop media discovery in release builds.
pub fn spotify_diagnostics() -> String {
    let service = media::MediaService::start(|_| {});
    for _ in 0..80 {
        if service.snapshot().revision > 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let mut state = service.snapshot();
    state.artwork = state
        .artwork
        .map(|data| format!("{} encoded bytes", data.len()));
    service.shutdown();
    format!("{state:#?}\n")
}

use audio::service::CaptureService;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;

#[derive(Default)]
struct Shutdown {
    started: AtomicBool,
    finished: AtomicBool,
}

fn begin_shutdown(app: &tauri::AppHandle) {
    let shutdown = app.state::<Arc<Shutdown>>().inner().clone();
    if shutdown.started.swap(true, Ordering::AcqRel) {
        return;
    }
    let service = app.state::<Arc<CaptureService>>().inner().clone();
    let recording = app
        .state::<Arc<recording::RecordingService>>()
        .inner()
        .clone();
    let media = app.state::<Arc<media::MediaService>>().inner().clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        recording.abort();
        let _ = service.shutdown();
        media.shutdown();
        shutdown.finished.store(true, Ordering::Release);
        app.exit(0);
    });
}

pub fn run() {
    let service = Arc::new(CaptureService::new());
    let service_clone = service.clone();
    let recording = Arc::new(recording::RecordingService::new(service.recording.clone()));

    tauri::Builder::default()
        .manage(service)
        .manage(recording)
        .manage(Arc::new(Shutdown::default()))
        .invoke_handler(tauri::generate_handler![
            commands::start_capture,
            commands::stop_capture,
            commands::get_snapshot,
            media::get_spotify_state,
            media::control_spotify,
            recording::begin_recording,
            recording::read_recording_audio,
            recording::append_recording_chunk,
            recording::finish_recording,
            recording::cancel_recording
        ])
        .setup(move |app| {
            use tauri::Emitter;
            let handle = app.handle().clone();
            service_clone.set_emitter(move |frame| {
                let _ = handle.emit("audio_frame", &frame);
            });
            let handle = app.handle().clone();
            app.manage(Arc::new(media::MediaService::start(move |state| {
                let _ = handle.emit("spotify_state", state);
            })));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                begin_shutdown(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Spanda")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !app
                    .state::<Arc<Shutdown>>()
                    .finished
                    .load(Ordering::Acquire)
                {
                    api.prevent_exit();
                    begin_shutdown(app);
                }
            }
        });
}
