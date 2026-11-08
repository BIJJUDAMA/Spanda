//! Desktop media controls are independent of system audio capture.
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(windows)]
mod windows;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub revision: u64,
    pub session_id: u64,
    pub available: bool,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork: Option<String>,
    pub playback: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub seek_start_ms: u64,
    pub seek_end_ms: u64,
    pub can_toggle: bool,
    pub can_previous: bool,
    pub can_next: bool,
    pub can_seek: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaAction {
    Toggle,
    Previous,
    Next,
    Seek,
}

pub(super) struct Request {
    session_id: u64,
    action: MediaAction,
    position_ms: Option<u64>,
    reply: mpsc::SyncSender<Result<(), String>>,
    expires: Instant,
}

pub struct MediaService {
    state: Arc<Mutex<MediaState>>,
    sender: mpsc::SyncSender<Request>,
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl MediaService {
    pub fn start(emit: impl Fn(&MediaState) + Send + 'static) -> Self {
        let state = Arc::new(Mutex::new(MediaState::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel(8);
        let worker_state = state.clone();
        let worker_stop = stop.clone();
        let worker = std::thread::spawn(move || {
            #[cfg(windows)]
            windows::run(receiver, worker_state, worker_stop, emit);
            #[cfg(not(windows))]
            {
                let _ = (receiver, worker_stop);
                let mut state = worker_state.lock().unwrap();
                state.error = Some("Spotify controls require Windows".into());
                emit(&state);
            }
        });
        Self {
            state,
            sender,
            stop,
            worker: Mutex::new(Some(worker)),
        }
    }

    pub fn snapshot(&self) -> MediaState {
        self.state.lock().unwrap().clone()
    }

    pub fn control(
        &self,
        session_id: u64,
        action: MediaAction,
        position_ms: Option<u64>,
    ) -> Result<(), String> {
        let (reply, result) = mpsc::sync_channel(1);
        self.sender
            .try_send(Request {
                session_id,
                action,
                position_ms,
                reply,
                expires: Instant::now() + Duration::from_secs(5),
            })
            .map_err(|_| "Spotify controls are busy or unavailable".to_string())?;
        result
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Spotify did not respond in time".to_string())?
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

#[tauri::command]
pub fn get_spotify_state(service: tauri::State<'_, Arc<MediaService>>) -> MediaState {
    service.snapshot()
}

#[tauri::command]
pub async fn control_spotify(
    service: tauri::State<'_, Arc<MediaService>>,
    session_id: u64,
    action: MediaAction,
    position_ms: Option<u64>,
) -> Result<(), String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.control(session_id, action, position_ms))
        .await
        .map_err(|e| e.to_string())?
}

fn spotify_identity(identity: &str) -> bool {
    identity.eq_ignore_ascii_case("Spotify.exe")
        || identity.eq_ignore_ascii_case("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify")
}

impl MediaState {
    fn reset(&mut self, session_id: u64, error: Option<String>) {
        *self = Self {
            session_id,
            error,
            ..Default::default()
        };
    }

    fn validate_control(&self, session_id: u64, action: MediaAction) -> Result<(), String> {
        if session_id != self.session_id || !self.available {
            return Err("Spotify session changed; try again".into());
        }
        let enabled = match action {
            MediaAction::Toggle => self.can_toggle,
            MediaAction::Previous => self.can_previous,
            MediaAction::Next => self.can_next,
            MediaAction::Seek => self.can_seek,
        };
        if enabled {
            Ok(())
        } else {
            Err("Spotify does not currently support this control".into())
        }
    }
}

fn timeline(
    start: i64,
    end: i64,
    position: i64,
    seek_start: i64,
    seek_end: i64,
) -> (u64, u64, u64, u64) {
    let end = end.max(start);
    let relative = |value: i64| value.clamp(start, end).saturating_sub(start) as u64 / 10_000;
    let lower = relative(seek_start);
    let upper = relative(seek_end).max(lower);
    (relative(position), relative(end), lower, upper)
}

fn advance_position(position: i64, updated: i64, now: i64, rate: f64, playing: bool) -> i64 {
    if !playing || updated <= 0 {
        return position;
    }
    let rate = if rate.is_finite() && rate > 0.0 {
        rate
    } else {
        1.0
    };
    let elapsed = now.saturating_sub(updated).max(0);
    position.saturating_add((elapsed as f64 * rate) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_desktop_spotify_identities_are_accepted() {
        assert!(spotify_identity("Spotify.exe"));
        assert!(spotify_identity(
            "spotifyab.spotifymusic_zpdnekdrzrea0!Spotify"
        ));
        for id in [
            "chrome.exe",
            "msedge.exe",
            "Spotify",
            "notSpotify.exe",
            "Spotify.exe.evil",
        ] {
            assert!(!spotify_identity(id));
        }
    }
    #[test]
    fn absent_session_clears_metadata_and_capabilities() {
        let mut state = MediaState {
            available: true,
            title: "Old track".into(),
            artist: "Old artist".into(),
            album: "Old album".into(),
            artwork: Some("old artwork".into()),
            can_toggle: true,
            can_next: true,
            can_previous: true,
            can_seek: true,
            position_ms: 500,
            duration_ms: 1000,
            ..Default::default()
        };
        state.reset(7, None);
        assert_eq!(state.session_id, 7);
        assert!(
            !state.available
                && !state.can_toggle
                && !state.can_previous
                && !state.can_next
                && !state.can_seek
        );
        assert!(state.title.is_empty() && state.artist.is_empty() && state.album.is_empty());
        assert_eq!(state.artwork, None);
        assert_eq!((state.position_ms, state.duration_ms), (0, 0));
    }
    #[test]
    fn controls_require_current_session_and_each_capability() {
        let mut state = MediaState {
            available: true,
            session_id: 3,
            can_toggle: true,
            ..Default::default()
        };
        assert!(state.validate_control(3, MediaAction::Toggle).is_ok());
        assert!(state.validate_control(2, MediaAction::Toggle).is_err());
        for action in [MediaAction::Previous, MediaAction::Next, MediaAction::Seek] {
            assert!(state.validate_control(3, action).is_err());
        }
        state.reset(4, None);
        assert!(state.validate_control(4, MediaAction::Toggle).is_err());
    }
    #[test]
    fn timeline_clamps_and_converts_windows_ticks() {
        assert_eq!(
            timeline(10_000, 110_000, 500_000, -10, 999_999),
            (10, 10, 0, 10)
        );
        assert_eq!(timeline(10_000, 110_000, -5, 30_000, 80_000), (0, 10, 2, 7));
        assert_eq!(timeline(50, -10, -20, 0, 100), (0, 0, 0, 0));
    }
    #[test]
    fn timeline_advances_from_last_report_only_while_playing() {
        assert_eq!(advance_position(10, 100, 150, 1.0, true), 60);
        assert_eq!(advance_position(10, 100, 150, 2.0, true), 110);
        assert_eq!(advance_position(10, 100, 150, 1.0, false), 10);
        assert_eq!(advance_position(10, 200, 150, 1.0, true), 10);
        assert_eq!(advance_position(10, 0, 150, 1.0, true), 10);
        assert_eq!(advance_position(10, 100, 150, f64::NAN, true), 60);
    }
}
