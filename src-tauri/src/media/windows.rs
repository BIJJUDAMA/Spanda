use super::*;
use ::windows::{
    core::{Error, Interface, HRESULT},
    Foundation::TypedEventHandler,
    Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    },
    Storage::Streams::DataReader,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::time::Instant;
use windows_future::{AsyncStatus, IAsyncInfo};

// WinRT calls run only on this worker, with a deadline so shutdown stays bounded.
macro_rules! wait {
    ($operation:expr) => {{
        (|| {
            let operation = $operation?;
            let info = operation.cast::<IAsyncInfo>()?;
            let deadline = Instant::now() + Duration::from_secs(2);
            while info.Status()? == AsyncStatus::Started {
                if Instant::now() >= deadline {
                    let _ = info.Cancel();
                    return Err(Error::from_hresult(HRESULT(0x800705B4u32 as i32)));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            operation.GetResults()
        })()
    }};
}

struct Selected {
    session: Session,
    media_token: i64,
    dirty: Arc<AtomicBool>,
    start: i64,
}

impl Selected {
    fn new(session: Session) -> ::windows::core::Result<Self> {
        let dirty = Arc::new(AtomicBool::new(true));
        let flag = dirty.clone();
        let media_token =
            session.MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
                flag.store(true, Ordering::Release);
                Ok(())
            }))?;
        Ok(Self {
            session,
            media_token,
            dirty,
            start: 0,
        })
    }

    fn update(&mut self, state: &mut MediaState) -> ::windows::core::Result<()> {
        if self.dirty.swap(false, Ordering::AcqRel) {
            let properties = wait!(self.session.TryGetMediaPropertiesAsync())?;
            state.title = properties.Title()?.to_string();
            state.artist = properties.Artist()?.to_string();
            state.album = properties.AlbumTitle()?.to_string();
            // Missing or malformed artwork must not discard otherwise valid metadata.
            state.artwork = artwork(&properties).ok();
        }
        let playback = self.session.GetPlaybackInfo()?;
        let status = playback.PlaybackStatus()?;
        state.playback = playback_name(status).into();
        let controls = playback.Controls()?;
        state.can_toggle = if status == Status::Playing {
            controls.IsPauseEnabled()?
        } else {
            controls.IsPlayEnabled()?
        };
        state.can_previous = controls.IsPreviousEnabled()?;
        state.can_next = controls.IsNextEnabled()?;
        let time = self.session.GetTimelineProperties()?;
        self.start = time.StartTime()?.Duration;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            / 100
            + 116_444_736_000_000_000;
        let position = advance_position(
            time.Position()?.Duration,
            time.LastUpdatedTime()?.UniversalTime,
            now.min(i64::MAX as u128) as i64,
            playback
                .PlaybackRate()
                .and_then(|rate| rate.Value())
                .unwrap_or(1.0),
            status == Status::Playing,
        );
        let (position, duration, lower, upper) = timeline(
            self.start,
            time.EndTime()?.Duration,
            position,
            time.MinSeekTime()?.Duration,
            time.MaxSeekTime()?.Duration,
        );
        state.position_ms = position;
        state.duration_ms = duration;
        state.seek_start_ms = lower;
        state.seek_end_ms = upper;
        state.can_seek = controls.IsPlaybackPositionEnabled()? && upper > lower;
        state.available = true;
        state.error = None;
        Ok(())
    }

    fn control(&self, request: &Request, state: &MediaState) -> Result<(), String> {
        if Instant::now() >= request.expires {
            return Err("Spotify command expired".into());
        }
        state.validate_control(request.session_id, request.action)?;
        let result = match request.action {
            MediaAction::Toggle if state.can_toggle => {
                if state.playback == "playing" {
                    wait!(self.session.TryPauseAsync())
                } else {
                    wait!(self.session.TryPlayAsync())
                }
            }
            MediaAction::Previous if state.can_previous => {
                wait!(self.session.TrySkipPreviousAsync())
            }
            MediaAction::Next if state.can_next => wait!(self.session.TrySkipNextAsync()),
            MediaAction::Seek if state.can_seek => {
                let position = request.position_ms.ok_or("Missing seek position")?;
                let position = position.clamp(state.seek_start_ms, state.seek_end_ms);
                let ticks = i64::try_from(position)
                    .ok()
                    .and_then(|ms| ms.checked_mul(10_000))
                    .and_then(|offset| self.start.checked_add(offset))
                    .ok_or("Invalid seek position")?;
                wait!(self.session.TryChangePlaybackPositionAsync(ticks))
            }
            _ => return Err("Spotify does not currently support this control".into()),
        }
        .map_err(|e| format!("Spotify control failed: {e}"))?;
        if result {
            Ok(())
        } else {
            Err("Spotify declined the command".into())
        }
    }
}

impl Drop for Selected {
    fn drop(&mut self) {
        let _ = self.session.RemoveMediaPropertiesChanged(self.media_token);
    }
}

fn playback_name(status: Status) -> &'static str {
    match status {
        Status::Playing => "playing",
        Status::Paused => "paused",
        Status::Stopped => "stopped",
        Status::Changing => "changing",
        Status::Closed => "closed",
        _ => "unknown",
    }
}

fn artwork(
    properties: &::windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> ::windows::core::Result<String> {
    let stream = wait!(properties.Thumbnail()?.OpenReadAsync())?;
    let size = stream.Size()?;
    let mime = stream.ContentType()?.to_string();
    if size == 0
        || size > 256 * 1024
        || !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp")
    {
        return Err(Error::from_hresult(HRESULT(0x80070057u32 as i32)));
    }
    let reader = DataReader::CreateDataReader(&stream)?;
    let loaded = wait!(reader.LoadAsync(size as u32))?;
    if u64::from(loaded) != size {
        return Err(Error::from_hresult(HRESULT(0x8007000Du32 as i32)));
    }
    let mut bytes = vec![0; size as usize];
    reader.ReadBytes(&mut bytes)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn find(manager: &Manager) -> ::windows::core::Result<Option<Session>> {
    for session in manager.GetSessions()? {
        if spotify_identity(&session.SourceAppUserModelId()?.to_string())
            && session.GetPlaybackInfo()?.PlaybackStatus()? != Status::Closed
        {
            return Ok(Some(session));
        }
    }
    Ok(None)
}

pub(super) fn run(
    receiver: mpsc::Receiver<Request>,
    shared: Arc<Mutex<MediaState>>,
    stop: Arc<AtomicBool>,
    emit: impl Fn(&MediaState),
) {
    let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let mut state = MediaState::default();
    if let Err(error) = initialized {
        state.error = Some(format!("Windows media access failed: {error}"));
        *shared.lock().unwrap() = state.clone();
        emit(&state);
        return;
    }
    let mut manager = None;
    let mut selected: Option<Selected> = None;
    let mut generation = 0;
    let mut revision = 0;
    let mut next_update = Instant::now();
    while !stop.load(Ordering::Acquire) {
        let request = match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(request) => Some(request),
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if request.is_some()
            || Instant::now() >= next_update
            || selected
                .as_ref()
                .is_some_and(|s| s.dirty.load(Ordering::Acquire))
        {
            let update = (|| -> ::windows::core::Result<()> {
                if manager.is_none() {
                    manager = Some(wait!(Manager::RequestAsync())?);
                }
                let found = find(manager.as_ref().unwrap())?;
                if found.as_ref() != selected.as_ref().map(|s| &s.session) {
                    selected = None;
                    generation += 1;
                    state.reset(generation, None);
                    if let Some(session) = found {
                        selected = Some(Selected::new(session)?);
                    }
                }
                if let Some(session) = &mut selected {
                    session.update(&mut state)?;
                }
                state.error = None;
                Ok(())
            })();
            if let Err(error) = update {
                selected = None;
                manager = None;
                generation += 1;
                state.reset(
                    generation,
                    Some(format!("Windows media access failed: {error}")),
                );
            }
            if let Some(request) = request {
                let result = match &selected {
                    Some(session) => session.control(&request, &state),
                    None => Err("Spotify unavailable".into()),
                };
                let _ = request.reply.send(result);
            }
            revision += 1;
            state.revision = revision;
            *shared.lock().unwrap() = state.clone();
            emit(&state);
            next_update = Instant::now() + Duration::from_secs(1);
        }
    }
    // Release interfaces and revoke handlers before uninitializing the apartment.
    drop(selected);
    drop(manager);
    unsafe { RoUninitialize() };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn playback_states_do_not_invent_playback() {
        assert_eq!(playback_name(Status::Playing), "playing");
        assert_eq!(playback_name(Status::Paused), "paused");
        assert_eq!(playback_name(Status::Closed), "closed");
        assert_eq!(playback_name(Status(999)), "unknown");
    }
}
