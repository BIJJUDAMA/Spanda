use crate::audio::types::AudioBlock;
use std::{
    fs::{self, File},
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const MAX_PCM_BYTES: usize = 2 * 1024 * 1024;
const MAX_CHUNK: usize = 8 * 1024 * 1024;
const MAX_FILE: u64 = 512 * 1024 * 1024;

struct Packet {
    rate: u32,
    channels: u16,
    samples: Vec<f32>,
    time: f64,
}
struct Producer {
    started: Instant,
    sender: SyncSender<Packet>,
}
#[derive(Default)]
pub struct RecordingTap {
    active: AtomicBool,
    failed: AtomicBool,
    queued_bytes: AtomicUsize,
    producer: Mutex<Option<Producer>>,
    receiver: Mutex<Option<Receiver<Packet>>>,
}
impl RecordingTap {
    pub fn push(&self, block: &AudioBlock) {
        if !self.active.load(Ordering::Acquire) {
            return;
        }
        // Only the capture producer uses this lock during recording. Pulls use a separate receiver.
        let Ok(guard) = self.producer.try_lock() else {
            return;
        };
        let Some(producer) = guard.as_ref() else {
            return;
        };
        if block.format.sample_rate == 0 || block.format.channels == 0 {
            return;
        }
        let bytes = block.samples.len() * 4;
        let queued = self.queued_bytes.fetch_add(bytes, Ordering::AcqRel);
        if queued.saturating_add(bytes) > MAX_PCM_BYTES {
            self.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
            self.failed.store(true, Ordering::Release);
            return;
        }
        let duration = block.samples.len() as f64
            / f64::from(block.format.channels)
            / f64::from(block.format.sample_rate);
        let time = (producer.started.elapsed().as_secs_f64() - duration).max(0.0);
        let packet = Packet {
            rate: block.format.sample_rate,
            channels: block.format.channels,
            samples: block.samples.clone(),
            time,
        };
        if producer.sender.try_send(packet).is_err() {
            self.queued_bytes.fetch_sub(bytes, Ordering::AcqRel);
            self.failed.store(true, Ordering::Release);
        }
    }
    fn start(&self) {
        let (sender, receiver) = mpsc::sync_channel(256);
        *self.producer.lock().unwrap() = Some(Producer {
            started: Instant::now(),
            sender,
        });
        *self.receiver.lock().unwrap() = Some(receiver);
        self.queued_bytes.store(0, Ordering::Release);
        self.failed.store(false, Ordering::Release);
        self.active.store(true, Ordering::Release);
    }
    fn stop(&self) {
        self.active.store(false, Ordering::Release);
        *self.producer.lock().unwrap() = None;
        *self.receiver.lock().unwrap() = None;
    }
    fn read(&self) -> Result<Vec<u8>, String> {
        if self.failed.load(Ordering::Acquire) {
            return Err(
                "Recording audio could not keep up. Stop and try again with lower render quality."
                    .into(),
            );
        }
        let guard = self.receiver.lock().unwrap();
        let receiver = guard.as_ref().ok_or("Recording has ended.")?;
        let mut result = Vec::new();
        // Bound each pull even if the producer continues supplying audio.
        for _ in 0..256 {
            let Ok(packet) = receiver.try_recv() else {
                break;
            };
            self.queued_bytes
                .fetch_sub(packet.samples.len() * 4, Ordering::AcqRel);
            result.extend_from_slice(&packet.rate.to_le_bytes());
            result.extend_from_slice(&u32::from(packet.channels).to_le_bytes());
            result.extend_from_slice(&(packet.samples.len() as u32).to_le_bytes());
            result.extend_from_slice(&packet.time.to_le_bytes());
            for sample in packet.samples {
                result.extend_from_slice(&sample.to_le_bytes());
            }
        }
        Ok(result)
    }
}

struct Output {
    id: String,
    file: File,
    temporary: PathBuf,
    destination: PathBuf,
    bytes: u64,
}
#[derive(Default)]
pub struct RecordingService {
    pub tap: Arc<RecordingTap>,
    output: Mutex<Option<Output>>,
}
#[derive(serde::Serialize)]
pub struct RecordingStarted {
    id: String,
    path: String,
}
impl RecordingService {
    pub fn new(tap: Arc<RecordingTap>) -> Self {
        Self {
            tap,
            output: Mutex::new(None),
        }
    }
    fn begin(&self, folder: PathBuf) -> Result<RecordingStarted, String> {
        let mut output = self.output.lock().unwrap();
        if output.is_some() {
            return Err("A recording is already active.".into());
        }
        fs::create_dir_all(&folder)
            .map_err(|e| format!("Cannot create the recording folder: {e}"))?;
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
            .to_string();
        let destination = folder.join(format!("Spanda-{id}.webm"));
        let temporary = destination.with_extension("webm.part");
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("Cannot create recording: {e}"))?;
        let path = destination.to_string_lossy().into_owned();
        *output = Some(Output {
            id: id.clone(),
            file,
            temporary,
            destination,
            bytes: 0,
        });
        self.tap.start();
        Ok(RecordingStarted { id, path })
    }
    fn check_id(&self, id: &str) -> Result<(), String> {
        if self
            .output
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|o| o.id == id)
        {
            Ok(())
        } else {
            Err("This recording is no longer active.".into())
        }
    }
    fn append(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > MAX_CHUNK {
            return Err("Recording chunk exceeded the safe size limit.".into());
        }
        let mut output = self.output.lock().unwrap();
        let output = output
            .as_mut()
            .filter(|o| o.id == id)
            .ok_or("This recording is no longer active.")?;
        if output.bytes == 0 && !bytes.starts_with(b"\x1a\x45\xdf\xa3") {
            return Err("The encoder did not produce a WebM file. Update Microsoft Edge WebView2 and try again.".into());
        }
        if output.bytes + bytes.len() as u64 > MAX_FILE {
            return Err("Recording reached its 512 MB clip limit.".into());
        }
        output
            .file
            .write_all(bytes)
            .map_err(|e| format!("Cannot write recording: {e}"))?;
        output.bytes += bytes.len() as u64;
        Ok(())
    }
    fn finish(&self, id: &str) -> Result<String, String> {
        let mut guard = self.output.lock().unwrap();
        if guard.as_ref().is_none_or(|o| o.id != id) {
            return Err("This recording is no longer active.".into());
        }
        self.tap.stop();
        let mut output = guard.take().unwrap();
        let result = (|| {
            if output.bytes == 0 {
                return Err("No video was recorded.".into());
            }
            output
                .file
                .flush()
                .map_err(|e| format!("Cannot finish recording: {e}"))?;
            output
                .file
                .sync_all()
                .map_err(|e| format!("Cannot save recording: {e}"))?;
            Ok(())
        })();
        drop(output.file);
        if let Err(error) = result {
            let _ = fs::remove_file(&output.temporary);
            return Err(error);
        }
        fs::rename(&output.temporary, &output.destination)
            .map_err(|e| format!("Recording remains at {}: {e}", output.temporary.display()))?;
        Ok(output.destination.to_string_lossy().into_owned())
    }
    pub fn abort(&self) {
        self.tap.stop();
        if let Some(output) = self.output.lock().unwrap().take() {
            drop(output.file);
            let _ = fs::remove_file(output.temporary);
        }
    }
}

#[tauri::command]
pub async fn begin_recording(
    app: tauri::AppHandle,
    service: tauri::State<'_, Arc<RecordingService>>,
    capture: tauri::State<'_, Arc<crate::audio::service::CaptureService>>,
) -> Result<RecordingStarted, String> {
    if capture.snapshot().state != crate::audio::capture::CaptureState::Running {
        return Err("Press Start and wait for system audio capture before recording.".into());
    }
    let folder = app
        .path()
        .video_dir()
        .map_err(|e| e.to_string())?
        .join("Spanda");
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.begin(folder))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn read_recording_audio(
    id: String,
    service: tauri::State<'_, Arc<RecordingService>>,
) -> Result<tauri::ipc::Response, String> {
    service.check_id(&id)?;
    Ok(tauri::ipc::Response::new(service.tap.read()?))
}
#[tauri::command]
pub async fn append_recording_chunk(
    request: tauri::ipc::Request<'_>,
    service: tauri::State<'_, Arc<RecordingService>>,
) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-recording-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("Recording identity is missing.")?
        .to_owned();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected encoded video bytes.".into());
    };
    if bytes.len() > MAX_CHUNK {
        return Err("Recording chunk exceeded the safe size limit.".into());
    }
    let bytes = bytes.clone();
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.append(&id, &bytes))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn finish_recording(
    id: String,
    service: tauri::State<'_, Arc<RecordingService>>,
) -> Result<String, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.finish(&id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn cancel_recording(
    id: String,
    service: tauri::State<'_, Arc<RecordingService>>,
) -> Result<(), String> {
    service.check_id(&id)?;
    service.abort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::types::AudioFormat;
    #[test]
    fn tap_is_opt_in_bounded_and_serializes_format() {
        let tap = RecordingTap::default();
        let block = AudioBlock {
            format: AudioFormat {
                sample_rate: 48000,
                channels: 2,
            },
            samples: vec![0.5, -0.5],
            discontinuity: false,
        };
        tap.push(&block);
        assert!(tap.read().is_err());
        tap.start();
        tap.push(&block);
        let bytes = tap.read().unwrap();
        assert_eq!(bytes.len(), 28);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 48000);
        assert_eq!(f32::from_le_bytes(bytes[20..24].try_into().unwrap()), 0.5);
        assert!(tap.read().unwrap().is_empty());
        let oversized = AudioBlock {
            samples: vec![0.0; MAX_PCM_BYTES / 4 + 1],
            ..block
        };
        tap.push(&oversized);
        assert!(tap.read().is_err());
        tap.stop();
    }
    #[test]
    fn file_lifecycle_rejects_stale_commands_and_removes_aborted_files() {
        let service = RecordingService::default();
        let folder = std::env::temp_dir().join(format!(
            "spanda-rec-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let started = service.begin(folder.clone()).unwrap();
        assert!(service.begin(folder.clone()).is_err());
        assert!(service.append("stale", b"bytes").is_err());
        assert!(started.path.ends_with(".webm"));
        assert!(service
            .append(&started.id, b"\x00\x00\x00\x18ftypisom")
            .is_err());
        let webm_header = b"\x1a\x45\xdf\xa3webm";
        service.append(&started.id, webm_header).unwrap();
        let path = service.finish(&started.id).unwrap();
        assert_eq!(fs::read(&path).unwrap(), webm_header);
        assert!(service.finish(&started.id).is_err());
        fs::remove_file(path).unwrap();
        service.begin(folder.clone()).unwrap();
        service.abort();
        assert_eq!(fs::read_dir(&folder).unwrap().count(), 0);
        fs::remove_dir(folder).unwrap();
    }
}
