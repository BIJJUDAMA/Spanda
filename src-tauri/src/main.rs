#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--probe-spotify") {
        let Some(path) = std::env::args_os().nth(2) else {
            std::process::exit(2);
        };
        if std::fs::write(path, spanda_lib::spotify_diagnostics()).is_err() {
            std::process::exit(2);
        }
        return;
    }
    // Run the access check in the same executable and packaging context as the app.
    if std::env::args().nth(1).as_deref() == Some("--probe-media-session") {
        let Some(path) = std::env::args_os().nth(2) else {
            std::process::exit(2);
        };
        let result = probe_media_session();
        let succeeded = result.is_ok();
        let report = match result {
            Ok(count) => format!("GSMTC access succeeded; sessions={count}\n"),
            Err(error) => format!("GSMTC access failed: {error}\n"),
        };
        if std::fs::write(path, report).is_err() {
            std::process::exit(2);
        }
        std::process::exit(if succeeded { 0 } else { 1 });
    }
    spanda_lib::run();
}

#[cfg(windows)]
fn probe_media_session() -> Result<u32, String> {
    use windows::{
        Media::Control::GlobalSystemMediaTransportControlsSessionManager,
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    };
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|e| e.to_string())?;
    let result = (|| {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.join()?;
        manager.GetSessions()?.Size()
    })();
    unsafe { RoUninitialize() };
    result.map_err(|e: windows::core::Error| e.to_string())
}

#[cfg(not(windows))]
fn probe_media_session() -> Result<u32, String> {
    Err("GSMTC requires Windows".into())
}
