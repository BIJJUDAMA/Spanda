pub mod audio;
mod commands;

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
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = service.shutdown();
        shutdown.finished.store(true, Ordering::Release);
        app.exit(0);
    });
}

pub fn run() {
    let service = Arc::new(CaptureService::new());
    let service_clone = service.clone();

    tauri::Builder::default()
        .manage(service)
        .manage(Arc::new(Shutdown::default()))
        .invoke_handler(tauri::generate_handler![
            commands::start_capture,
            commands::stop_capture,
            commands::get_snapshot
        ])
        .setup(move |app| {
            use tauri::Emitter;
            let handle = app.handle().clone();
            service_clone.set_emitter(move |frame| {
                let _ = handle.emit("audio_frame", &frame);
            });
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
