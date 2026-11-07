use std::sync::{atomic::AtomicBool, Arc};
use std::time::{Duration, Instant};

use windows::Win32::Media::Audio::*;
use windows::{
    core::HRESULT,
    Win32::{
        Foundation::ERROR_NOT_FOUND,
        Media::{
            KernelStreaming::{KSDATAFORMAT_SUBTYPE_PCM, WAVE_FORMAT_EXTENSIBLE},
            Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT},
        },
        System::Com::{
            CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
        },
    },
};

use super::format::{decode_packet, SampleEncoding, SampleFormat};
use super::notifications::{Event, Registration, Signals};
use crate::audio::{
    capture::{AudioCapture, CaptureState},
    types::{AudioBlock, CaptureError},
};

const WAIT_SLICE: Duration = Duration::from_millis(50);
const RETRY_DELAY: Duration = Duration::from_secs(1);

/// One capture generation. Construction creates only wake events, never COM
/// objects or an audio stream. Call `run` on a dedicated owning worker.
pub struct WindowsWasapiCapture {
    signals: Arc<Signals>,
}

/// Thread-safe cancellation for one generation; stop is latched, including
/// before `run`. A fresh generation needs a fresh adapter/handle pair.
#[derive(Clone)]
pub struct CaptureStopHandle {
    signals: Arc<Signals>,
}

impl CaptureStopHandle {
    pub fn stop(&self) {
        self.signals.request_stop();
    }
}

impl WindowsWasapiCapture {
    pub fn new() -> Result<Self, CaptureError> {
        Ok(Self {
            signals: Arc::new(Signals::new()?),
        })
    }

    pub fn stop_handle(&self) -> CaptureStopHandle {
        CaptureStopHandle {
            signals: self.signals.clone(),
        }
    }

    /// Progress only; the service must publish terminal lifecycle events after
    /// retiring the worker. Both callbacks must remain bounded and nonblocking.
    pub fn run_with_state(
        &mut self,
        stop: &AtomicBool,
        sink: &mut dyn FnMut(&AudioBlock),
        state: &mut dyn FnMut(CaptureState),
    ) -> Result<(), CaptureError> {
        if self.signals.cancelled(stop) {
            return Ok(());
        }
        state(CaptureState::Starting);
        let result = (|| {
            // Declared first, dropped last: all COM references and registration
            // stay on this thread and are released before CoUninitialize.
            let _com = ComApartment::new()?;
            let registration = Registration::new(self.signals.clone())?;
            let mut backend = NativeSource {
                registration,
                signals: self.signals.clone(),
            };
            run_source(&mut backend, &self.signals, stop, sink, state)
        })();
        if result.is_err() && !self.signals.cancelled(stop) {
            state(CaptureState::Error);
        }
        result
    }
}

impl AudioCapture for WindowsWasapiCapture {
    fn run(
        &mut self,
        stop: &AtomicBool,
        sink: &mut dyn FnMut(&AudioBlock),
    ) -> Result<(), CaptureError> {
        self.run_with_state(stop, sink, &mut |_| {})
    }
}

#[derive(Debug)]
enum Failure {
    Retry(CaptureError),
    Fatal(CaptureError),
}

#[derive(Clone, Copy)]
struct OpenRequest {
    flow: EDataFlow,
    role: ERole,
    mode: AUDCLNT_SHAREMODE,
    flags: u32,
}

const LOOPBACK: OpenRequest = OpenRequest {
    flow: eRender,
    role: eMultimedia,
    mode: AUDCLNT_SHAREMODE_SHARED,
    flags: AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
};

trait Packet {
    fn frames(&self) -> usize;
    fn flags(&self) -> u32;
    fn bytes(&self) -> Result<&[u8], CaptureError>;
    fn release(self) -> Result<(), Failure>;
}

trait Session {
    type Packet<'a>: Packet
    where
        Self: 'a;
    fn format(&self) -> SampleFormat;
    fn acquire(&mut self) -> Result<Option<Self::Packet<'_>>, Failure>;
}

trait EndpointSource {
    type Session: Session;
    fn open(&mut self, request: OpenRequest) -> Result<Self::Session, Failure>;
    fn wait(
        &mut self,
        session: Option<&Self::Session>,
        timeout: Duration,
    ) -> Result<(), CaptureError>;
    fn now(&self) -> Instant;
}

fn run_source<B: EndpointSource>(
    backend: &mut B,
    signals: &Signals,
    stop: &AtomicBool,
    sink: &mut dyn FnMut(&AudioBlock),
    state: &mut dyn FnMut(CaptureState),
) -> Result<(), CaptureError> {
    let mut session: Option<B::Session> = None;
    let mut retry_at = backend.now();
    let mut discontinuity = true;
    let mut block = AudioBlock {
        format: crate::audio::types::AudioFormat {
            sample_rate: 0,
            channels: 0,
        },
        samples: Vec::new(),
        discontinuity: true,
    };
    while !signals.cancelled(stop) {
        if signals.take_change() && session.take().is_some() {
            state(CaptureState::Recovering);
            retry_at = backend.now();
            discontinuity = true;
            block.samples.clear();
        }
        if session.is_none() && backend.now() >= retry_at {
            match backend.open(LOOPBACK) {
                Ok(opened) => {
                    if signals.cancelled(stop) {
                        return Ok(());
                    }
                    block.format = opened.format().audio;
                    session = Some(opened);
                    discontinuity = true;
                    state(CaptureState::Running);
                }
                Err(Failure::Retry(_reason)) => {
                    state(CaptureState::Recovering);
                    retry_at = backend.now() + RETRY_DELAY;
                }
                Err(Failure::Fatal(reason)) => return Err(reason),
            }
        }
        if let Some(active) = session.as_mut() {
            let format = active.format();
            let drained = (|| {
                // Check cancellation/change between packets even if a driver
                // continuously supplies data and the queue never empties.
                while !signals.cancelled(stop) && !signals.has_change() {
                    let Some(packet) = active.acquire()? else {
                        break;
                    };
                    let flags = packet.flags();
                    let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                    let decoded = (|| {
                        let bytes = if silent { &[] } else { packet.bytes()? };
                        decode_packet(bytes, &format, packet.frames(), silent, &mut block.samples)
                    })();
                    // Release before returning a decode error or calling user
                    // code. Packet Drop is also a guard during unwinding.
                    let released = packet.release();
                    decoded.map_err(Failure::Fatal)?;
                    released?;
                    block.discontinuity = discontinuity
                        || flags
                            & (AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0
                                | AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0)
                                as u32
                            != 0;
                    if signals.cancelled(stop) || signals.has_change() {
                        break;
                    }
                    sink(&block);
                    discontinuity = false;
                }
                Ok::<(), Failure>(())
            })();
            match drained {
                Err(Failure::Retry(_reason)) => {
                    session = None;
                    block.samples.clear();
                    discontinuity = true;
                    state(CaptureState::Recovering);
                    retry_at = backend.now() + RETRY_DELAY;
                }
                Err(Failure::Fatal(reason)) => return Err(reason),
                Ok(()) => (),
            }
        }
        if signals.cancelled(stop) {
            break;
        }
        if signals.has_change() {
            continue;
        }
        let timeout = if session.is_some() {
            WAIT_SLICE
        } else {
            WAIT_SLICE.min(retry_at.saturating_duration_since(backend.now()))
        };
        backend.wait(session.as_ref(), timeout)?;
    }
    Ok(())
}

fn error(code: &str, message: &str) -> CaptureError {
    CaptureError {
        code: code.into(),
        message: message.into(),
    }
}

pub(super) fn native_error(operation: &str, e: windows::core::Error) -> CaptureError {
    error(operation, &format!("WASAPI {operation} failed: {e} ({}). Check the Windows default output and audio service.", e.code()))
}

fn failure(operation: &str, e: windows::core::Error) -> Failure {
    let code = e.code();
    let reason = if code == HRESULT::from_win32(ERROR_NOT_FOUND.0) {
        error("no_default_output", "No Windows default output. Connect or enable an output in Windows sound settings; capture will retry.")
    } else {
        native_error(operation, e)
    };
    if code == HRESULT::from_win32(ERROR_NOT_FOUND.0)
        || code == AUDCLNT_E_DEVICE_INVALIDATED
        || code == AUDCLNT_E_RESOURCES_INVALIDATED
        || code == AUDCLNT_E_SERVICE_NOT_RUNNING
    {
        Failure::Retry(reason)
    } else {
        Failure::Fatal(reason)
    }
}

// !Send/!Sync: the apartment guard must be destroyed on its initializing thread.
struct ComApartment(std::marker::PhantomData<std::rc::Rc<()>>);
impl ComApartment {
    fn new() -> Result<Self, CaptureError> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|e| native_error("initialize_com_on_worker", e))?;
        Ok(Self(std::marker::PhantomData))
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct MixFormat(*mut WAVEFORMATEX);
impl Drop for MixFormat {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0.cast())) };
    }
}
impl MixFormat {
    fn parse(&self) -> Result<SampleFormat, CaptureError> {
        if self.0.is_null() {
            return Err(error(
                "invalid_format",
                "Windows returned a null mix format",
            ));
        }
        // GetMixFormat owns an allocation containing WAVEFORMATEX plus cbSize
        // bytes. Read packed structs unaligned and never borrow packed fields.
        let header = unsafe { self.0.read_unaligned() };
        let len = std::mem::size_of::<WAVEFORMATEX>() + usize::from(header.cbSize);
        let bytes = unsafe { std::slice::from_raw_parts(self.0.cast::<u8>(), len) };
        parse_mix_format(bytes)
    }
}

fn parse_mix_format(bytes: &[u8]) -> Result<SampleFormat, CaptureError> {
    let unsupported = || {
        error("unsupported_format", "Unsupported or malformed Windows output mix format. Choose float32 or signed PCM16/24/32 in Windows sound output settings.")
    };
    let header_len = std::mem::size_of::<WAVEFORMATEX>();
    if bytes.len() < header_len {
        return Err(unsupported());
    }
    // Length checks precede each unaligned read of the native packed structs.
    let header = unsafe { bytes.as_ptr().cast::<WAVEFORMATEX>().read_unaligned() };
    if bytes.len() < header_len + usize::from(header.cbSize) {
        return Err(unsupported());
    }
    let (encoding, valid_bits) = match u32::from(header.wFormatTag) {
        WAVE_FORMAT_PCM => (SampleEncoding::SignedPcm, header.wBitsPerSample),
        WAVE_FORMAT_IEEE_FLOAT => (SampleEncoding::Float, header.wBitsPerSample),
        WAVE_FORMAT_EXTENSIBLE => {
            if usize::from(header.cbSize) < std::mem::size_of::<WAVEFORMATEXTENSIBLE>() - header_len
            {
                return Err(unsupported());
            }
            let ext = unsafe {
                bytes
                    .as_ptr()
                    .cast::<WAVEFORMATEXTENSIBLE>()
                    .read_unaligned()
            };
            let subformat = ext.SubFormat;
            let encoding = if subformat == KSDATAFORMAT_SUBTYPE_PCM {
                SampleEncoding::SignedPcm
            } else if subformat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {
                SampleEncoding::Float
            } else {
                return Err(unsupported());
            };
            let mask = ext.dwChannelMask;
            if mask != 0 && mask.count_ones() != u32::from(header.nChannels) {
                return Err(unsupported());
            }
            (encoding, unsafe { ext.Samples.wValidBitsPerSample })
        }
        _ => return Err(unsupported()),
    };
    let format = SampleFormat {
        audio: crate::audio::types::AudioFormat {
            sample_rate: header.nSamplesPerSec,
            channels: header.nChannels,
        },
        encoding,
        container_bits: header.wBitsPerSample,
        valid_bits,
    };
    // Reuse the approved pure descriptor validation without reading samples.
    decode_packet(&[], &format, 0, true, &mut Vec::new()).map_err(|_| unsupported())?;
    let align = header
        .nChannels
        .checked_mul(header.wBitsPerSample / 8)
        .ok_or_else(unsupported)?;
    if header.nBlockAlign != align
        || header.nSamplesPerSec.checked_mul(u32::from(align)) != Some(header.nAvgBytesPerSec)
    {
        return Err(unsupported());
    }
    Ok(format)
}

struct NativeSource {
    registration: Registration,
    signals: Arc<Signals>,
}
impl EndpointSource for NativeSource {
    type Session = NativeSession;
    fn open(&mut self, request: OpenRequest) -> Result<NativeSession, Failure> {
        NativeSession::open(&self.registration.enumerator, request)
    }
    fn wait(
        &mut self,
        session: Option<&NativeSession>,
        timeout: Duration,
    ) -> Result<(), CaptureError> {
        self.signals
            .wait(session.map(|s| &s.audio_event), timeout)
            .map(|_| ())
    }
    fn now(&self) -> Instant {
        Instant::now()
    }
}

struct NativeSession {
    capture: IAudioCaptureClient,
    client: IAudioClient,
    _device: IMMDevice,
    audio_event: Event,
    format: SampleFormat,
    max_frames: u32,
}
impl NativeSession {
    fn open(enumerator: &IMMDeviceEnumerator, request: OpenRequest) -> Result<Self, Failure> {
        // Event precedes client creation so early-error stack unwinding drops
        // the client before closing the event that Initialize may reference.
        let audio_event = Event::new(false).map_err(Failure::Fatal)?;
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(request.flow, request.role) }
            .map_err(|e| failure("default_output", e))?;
        let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|e| failure("activate_capture", e))?;
        let mix =
            MixFormat(unsafe { client.GetMixFormat() }.map_err(|e| failure("mix_format", e))?);
        let format = mix.parse().map_err(Failure::Fatal)?;
        // Shared mode only. Zero periodicity/duration select the engine's
        // normal period. No render client, volume or routing API is opened.
        unsafe { client.Initialize(request.mode, request.flags, 0, 0, mix.0, None) }
            .map_err(|e| failure("initialize_shared_loopback", e))?;
        unsafe { client.SetEventHandle(audio_event.handle()) }
            .map_err(|e| failure("set_audio_event", e))?;
        let max_frames =
            unsafe { client.GetBufferSize() }.map_err(|e| failure("buffer_size", e))?;
        let capture = unsafe { client.GetService::<IAudioCaptureClient>() }
            .map_err(|e| failure("capture_service", e))?;
        let session = Self {
            capture,
            client,
            _device: device,
            audio_event,
            format,
            max_frames,
        };
        unsafe { session.client.Start() }.map_err(|e| failure("start_loopback", e))?;
        Ok(session)
    }
}
impl Drop for NativeSession {
    fn drop(&mut self) {
        // Also handles a partially successful Start. Fields release in order:
        // capture service, audio client, device, then its event handle.
        let _ = unsafe { self.client.Stop() };
    }
}
impl Session for NativeSession {
    type Packet<'a> = NativePacket<'a>;
    fn format(&self) -> SampleFormat {
        self.format
    }
    fn acquire(&mut self) -> Result<Option<NativePacket<'_>>, Failure> {
        acquire_packet(&self.capture, self.format, self.max_frames)
    }
}

struct NativePacket<'a> {
    capture: &'a IAudioCaptureClient,
    data: *mut u8,
    frames: u32,
    flags: u32,
    format: SampleFormat,
    max_frames: u32,
    released: bool,
}
fn acquire_packet(
    capture: &IAudioCaptureClient,
    format: SampleFormat,
    max_frames: u32,
) -> Result<Option<NativePacket<'_>>, Failure> {
    let mut data = std::ptr::null_mut();
    let mut frames = 0;
    let mut flags = 0;
    unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
        .map_err(|e| failure("get_packet", e))?;
    // The binding maps AUDCLNT_S_BUFFER_EMPTY to Ok; frames, not Result, tells
    // us whether a packet was actually acquired. Zero frames need no release.
    if frames == 0 {
        return Ok(None);
    }
    Ok(Some(NativePacket {
        capture,
        data,
        frames,
        flags,
        format,
        max_frames,
        released: false,
    }))
}
impl Packet for NativePacket<'_> {
    fn frames(&self) -> usize {
        self.frames as usize
    }
    fn flags(&self) -> u32 {
        self.flags
    }
    fn bytes(&self) -> Result<&[u8], CaptureError> {
        if self.data.is_null() || self.frames > self.max_frames {
            return Err(error(
                "invalid_packet",
                "Windows returned an invalid non-silent packet pointer or frame count",
            ));
        }
        let len = (self.frames as usize)
            .checked_mul(usize::from(self.format.audio.channels))
            .and_then(|n| n.checked_mul(usize::from(self.format.container_bits / 8)))
            .filter(|&n| n <= isize::MAX as usize)
            .ok_or_else(|| error("invalid_packet", "Windows packet byte count overflow"))?;
        // WASAPI guarantees this complete packet is valid until ReleaseBuffer.
        Ok(unsafe { std::slice::from_raw_parts(self.data, len) })
    }
    fn release(mut self) -> Result<(), Failure> {
        self.released = true;
        unsafe { self.capture.ReleaseBuffer(self.frames) }.map_err(|e| failure("release_packet", e))
    }
}
impl Drop for NativePacket<'_> {
    fn drop(&mut self) {
        if !self.released {
            let _ = unsafe { self.capture.ReleaseBuffer(self.frames) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{format::SampleEncoding, notifications::Signals};
    use super::*;
    use crate::audio::types::AudioFormat;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::{cell::RefCell, collections::VecDeque, rc::Rc};
    use windows::{core::implement, Win32::Foundation::E_NOTIMPL};

    #[implement(IAudioCaptureClient)]
    struct NativeBufferFake {
        frames: u32,
        flags: u32,
        releases: Arc<AtomicUsize>,
        release_fails: bool,
    }
    impl IAudioCaptureClient_Impl for NativeBufferFake_Impl {
        fn GetBuffer(
            &self,
            data: *mut *mut u8,
            frames: *mut u32,
            flags: *mut u32,
            _: *mut u64,
            _: *mut u64,
        ) -> windows::core::Result<()> {
            unsafe {
                *data = std::ptr::null_mut();
                *frames = self.frames;
                *flags = self.flags;
            }
            Ok(())
        }
        fn ReleaseBuffer(&self, frames: u32) -> windows::core::Result<()> {
            assert_eq!(frames, self.frames);
            self.releases.fetch_add(1, Ordering::SeqCst);
            if self.release_fails {
                Err(AUDCLNT_E_DEVICE_INVALIDATED.into())
            } else {
                Ok(())
            }
        }
        fn GetNextPacketSize(&self) -> windows::core::Result<u32> {
            Err(E_NOTIMPL.into())
        }
    }

    #[test]
    fn native_packet_guard_releases_on_error_unwind_and_release_failure() {
        let format = parse_mix_format(&EXT_FLOAT).unwrap();
        for release_fails in [false, true] {
            let releases = Arc::new(AtomicUsize::new(0));
            let capture: IAudioCaptureClient = NativeBufferFake {
                frames: 1,
                flags: 0,
                releases: releases.clone(),
                release_fails,
            }
            .into();
            let packet = acquire_packet(&capture, format, 100).unwrap().unwrap();
            assert_eq!(packet.bytes().unwrap_err().code, "invalid_packet");
            drop(packet);
            assert_eq!(releases.load(Ordering::SeqCst), 1);
            let packet = acquire_packet(&capture, format, 100).unwrap().unwrap();
            assert_eq!(packet.release().is_err(), release_fails);
            assert_eq!(
                releases.load(Ordering::SeqCst),
                2,
                "never release twice after a ReleaseBuffer error"
            );
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _packet = acquire_packet(&capture, format, 100).unwrap().unwrap();
                panic!("simulate decoding unwind");
            }));
            assert_eq!(releases.load(Ordering::SeqCst), 3);
        }
    }

    #[test]
    fn native_empty_packet_needs_no_release_and_silent_null_is_valid() {
        let format = parse_mix_format(&EXT_FLOAT).unwrap();
        for frames in [0, 1] {
            let releases = Arc::new(AtomicUsize::new(0));
            let capture: IAudioCaptureClient = NativeBufferFake {
                frames,
                flags: AUDCLNT_BUFFERFLAGS_SILENT.0 as u32,
                releases: releases.clone(),
                release_fails: false,
            }
            .into();
            let packet = acquire_packet(&capture, format, 100).unwrap();
            if let Some(packet) = packet {
                let mut samples = Vec::new();
                decode_packet(&[], &format, packet.frames(), true, &mut samples).unwrap();
                assert_eq!(samples, [0.0, 0.0]);
                packet.release().unwrap();
            }
            assert_eq!(releases.load(Ordering::SeqCst), frames as usize);
        }
    }

    const EXT_FLOAT: [u8; 40] = [
        0xfe, 0xff, 2, 0, 0x80, 0xbb, 0, 0, 0, 0xdc, 5, 0, 8, 0, 32, 0, 22, 0, 32, 0, 3, 0, 0, 0,
        3, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71,
    ];

    #[test]
    fn native_extensible_float_and_pcm_valid_bits() {
        let float = parse_mix_format(&EXT_FLOAT).unwrap();
        assert_eq!(
            float.audio,
            AudioFormat {
                sample_rate: 48_000,
                channels: 2
            }
        );
        assert_eq!(float.encoding, SampleEncoding::Float);
        assert_eq!((float.container_bits, float.valid_bits), (32, 32));
        let mut pcm = EXT_FLOAT;
        pcm[18] = 24;
        pcm[24] = 1;
        let pcm = parse_mix_format(&pcm).unwrap();
        assert_eq!(pcm.encoding, SampleEncoding::SignedPcm);
        assert_eq!((pcm.container_bits, pcm.valid_bits), (32, 24));
    }

    #[test]
    fn native_legacy_pcm_and_float() {
        let mut bytes = EXT_FLOAT[..18].to_vec();
        bytes[0..2].copy_from_slice(&3_u16.to_le_bytes());
        bytes[16..18].copy_from_slice(&0_u16.to_le_bytes());
        assert_eq!(
            parse_mix_format(&bytes).unwrap().encoding,
            SampleEncoding::Float
        );
        bytes[0] = 1;
        bytes[8..12].copy_from_slice(&192_000_u32.to_le_bytes());
        bytes[12] = 4;
        bytes[14] = 16;
        let pcm = parse_mix_format(&bytes).unwrap();
        assert_eq!(pcm.encoding, SampleEncoding::SignedPcm);
        assert_eq!(pcm.valid_bits, 16);
    }

    #[test]
    fn native_malformed_and_unsupported_formats_are_actionable() {
        for len in [0, 17, 18, 39] {
            let err = parse_mix_format(&EXT_FLOAT[..len]).unwrap_err();
            assert_eq!(err.code, "unsupported_format");
            assert!(err.message.contains("Windows"));
        }
        for (offset, value) in [
            (16, 21),
            (24, 99),
            (18, 0),
            (18, 24),
            (12, 7),
            (8, 1),
            (2, 0),
            (20, 1),
            (14, 64),
        ] {
            let mut bytes = EXT_FLOAT;
            bytes[offset] = value;
            assert_eq!(
                parse_mix_format(&bytes).unwrap_err().code,
                "unsupported_format",
                "offset {offset}"
            );
        }
    }

    #[derive(Default)]
    struct Trace {
        opens: Vec<OpenRequest>,
        open_times: Vec<Instant>,
        releases: usize,
        reads: usize,
        drops: usize,
    }
    type Log = Rc<RefCell<Trace>>;

    struct FakePacket {
        bytes: Vec<u8>,
        flags: u32,
        frames: usize,
        released: bool,
        release_error: bool,
        log: Log,
    }
    impl Packet for FakePacket {
        fn frames(&self) -> usize {
            self.frames
        }
        fn flags(&self) -> u32 {
            self.flags
        }
        fn bytes(&self) -> Result<&[u8], CaptureError> {
            self.log.borrow_mut().reads += 1;
            assert_eq!(
                self.flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32,
                0,
                "silent pointer read"
            );
            Ok(&self.bytes)
        }
        fn release(mut self) -> Result<(), Failure> {
            self.released = true;
            self.log.borrow_mut().releases += 1;
            if self.release_error {
                Err(Failure::Retry(error("device_lost", "release invalidated")))
            } else {
                Ok(())
            }
        }
    }
    impl Drop for FakePacket {
        fn drop(&mut self) {
            if !self.released {
                self.log.borrow_mut().releases += 1;
            }
        }
    }
    struct FakeSession {
        format: SampleFormat,
        packets: VecDeque<FakePacket>,
        invalidated: bool,
        log: Log,
    }
    impl Session for FakeSession {
        type Packet<'a> = FakePacket;
        fn format(&self) -> SampleFormat {
            self.format
        }
        fn acquire(&mut self) -> Result<Option<FakePacket>, Failure> {
            if self.invalidated {
                return Err(Failure::Retry(error("device_lost", "unplugged")));
            }
            Ok(self.packets.pop_front())
        }
    }
    impl Drop for FakeSession {
        fn drop(&mut self) {
            self.log.borrow_mut().drops += 1;
        }
    }
    enum Wake {
        Change,
        Stop,
        Tick,
        AtomicStop,
    }
    struct FakeSource {
        opens: VecDeque<Result<FakeSession, Failure>>,
        wakes: VecDeque<Wake>,
        signals: Arc<Signals>,
        stop: Arc<AtomicBool>,
        now: Instant,
        log: Log,
    }
    impl EndpointSource for FakeSource {
        type Session = FakeSession;
        fn open(&mut self, request: OpenRequest) -> Result<FakeSession, Failure> {
            self.log.borrow_mut().opens.push(request);
            self.log.borrow_mut().open_times.push(self.now);
            self.opens.pop_front().expect("unexpected reopen")
        }
        fn wait(&mut self, _: Option<&FakeSession>, timeout: Duration) -> Result<(), CaptureError> {
            assert!(timeout <= Duration::from_millis(50));
            self.now += timeout;
            match self.wakes.pop_front().unwrap_or(Wake::Stop) {
                Wake::Change => self.signals.device_changed(),
                Wake::Stop => self.signals.request_stop(),
                Wake::AtomicStop => self.stop.store(true, Ordering::Release),
                Wake::Tick => (),
            }
            Ok(())
        }
        fn now(&self) -> Instant {
            self.now
        }
    }
    fn source() -> FakeSource {
        FakeSource {
            opens: VecDeque::new(),
            wakes: VecDeque::new(),
            signals: Arc::new(Signals::new().unwrap()),
            stop: Arc::new(AtomicBool::new(false)),
            now: Instant::now(),
            log: Rc::new(RefCell::new(Trace::default())),
        }
    }
    fn session(source: &FakeSource, rate: u32, bytes: &[u8], flags: u32) -> FakeSession {
        FakeSession {
            format: SampleFormat {
                audio: AudioFormat {
                    sample_rate: rate,
                    channels: 2,
                },
                encoding: SampleEncoding::Float,
                container_bits: 32,
                valid_bits: 32,
            },
            packets: VecDeque::from([FakePacket {
                bytes: bytes.into(),
                flags,
                frames: 1,
                released: false,
                release_error: false,
                log: source.log.clone(),
            }]),
            invalidated: false,
            log: source.log.clone(),
        }
    }
    fn run(
        source: &mut FakeSource,
    ) -> (Result<(), CaptureError>, Vec<AudioBlock>, Vec<CaptureState>) {
        let mut blocks = Vec::new();
        let mut states = Vec::new();
        let signals = source.signals.clone();
        let stop = source.stop.clone();
        let result = run_source(
            source,
            &signals,
            &stop,
            &mut |block| blocks.push(block.clone()),
            &mut |state| states.push(state),
        );
        (result, blocks, states)
    }

    #[test]
    fn start_selects_default_render() {
        let mut src = source();
        src.opens.push_back(Ok(session(&src, 48_000, &[0; 8], 0)));
        let (result, blocks, states) = run(&mut src);
        result.unwrap();
        let log = src.log.borrow();
        assert_eq!(log.opens.len(), 1);
        let request = log.opens[0];
        assert_eq!(request.flow, eRender);
        assert_eq!(request.role, eMultimedia);
        assert_eq!(request.mode, AUDCLNT_SHAREMODE_SHARED);
        assert_eq!(
            request.flags,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        );
        // The seam exposes capture only: no render-client, routing or volume operations.
        assert_eq!(blocks[0].format.sample_rate, 48_000);
        assert!(states.contains(&CaptureState::Running));
        assert_eq!(log.drops, 1);
        assert_eq!(log.releases, 1);
    }
    #[test]
    fn rebind_renegotiates_format() {
        let mut src = source();
        src.opens.push_back(Ok(session(&src, 48_000, &[0; 8], 0)));
        src.opens.push_back(Ok(session(&src, 44_100, &[0; 8], 0)));
        src.wakes.push_back(Wake::Change);
        let (result, blocks, states) = run(&mut src);
        result.unwrap();
        assert_eq!(
            blocks
                .iter()
                .map(|b| b.format.sample_rate)
                .collect::<Vec<_>>(),
            [48_000, 44_100]
        );
        assert!(blocks[1].discontinuity);
        assert!(states.contains(&CaptureState::Recovering));
        assert_eq!(src.log.borrow().drops, 2);
    }
    #[test]
    fn null_default_enters_recovery() {
        let mut src = source();
        src.opens.push_back(Err(Failure::Retry(error(
            "no_default_output",
            "Connect an output",
        ))));
        let (result, blocks, states) = run(&mut src);
        result.unwrap();
        assert!(blocks.is_empty());
        assert!(states.contains(&CaptureState::Recovering));
        assert!(!states.contains(&CaptureState::Running));
        assert_eq!(src.log.borrow().opens.len(), 1);
    }
    #[test]
    fn silent_flag_skips_buffer_read() {
        let mut src = source();
        src.opens.push_back(Ok(session(
            &src,
            48_000,
            &[],
            AUDCLNT_BUFFERFLAGS_SILENT.0 as u32,
        )));
        let (result, blocks, _) = run(&mut src);
        result.unwrap();
        assert_eq!(blocks[0].samples, [0.0, 0.0]);
        assert_eq!(src.log.borrow().reads, 0);
        assert_eq!(src.log.borrow().releases, 1);
    }
    #[test]
    fn stop_wakes_idle_wait() {
        let mut src = source();
        let mut idle = session(&src, 48_000, &[0; 8], 0);
        idle.packets.clear();
        src.opens.push_back(Ok(idle));
        let (result, blocks, _) = run(&mut src);
        result.unwrap();
        assert!(blocks.is_empty());
        assert_eq!(src.log.borrow().drops, 1);
    }
    #[test]
    fn stop_during_retry_and_atomic_only_stop() {
        for wake in [Wake::Stop, Wake::AtomicStop] {
            let mut src = source();
            src.opens.push_back(Err(Failure::Retry(error(
                "no_default_output",
                "Connect an output",
            ))));
            src.wakes.extend([Wake::Tick, wake]);
            let start = src.now;
            run(&mut src).0.unwrap();
            assert!(src.now.duration_since(start) <= Duration::from_millis(100));
            assert_eq!(src.log.borrow().opens.len(), 1);
        }
    }
    #[test]
    fn notifications_cannot_accelerate_recovery_retries() {
        let mut src = source();
        for _ in 0..2 {
            src.opens.push_back(Err(Failure::Retry(error(
                "no_default_output",
                "Connect an output",
            ))));
        }
        src.wakes.extend((0..25).map(|_| Wake::Change));
        run(&mut src).0.unwrap();
        let log = src.log.borrow();
        assert_eq!(log.open_times.len(), 2);
        assert!(log.open_times[1].duration_since(log.open_times[0]) >= Duration::from_secs(1));
    }
    #[test]
    fn conversion_error_releases_packet_and_session() {
        let mut src = source();
        src.opens.push_back(Ok(session(&src, 48_000, &[0; 3], 0)));
        let (result, blocks, _) = run(&mut src);
        assert_eq!(result.unwrap_err().code, "invalid_packet");
        assert!(blocks.is_empty());
        assert_eq!(src.log.borrow().releases, 1);
        assert_eq!(src.log.borrow().drops, 1);
    }
    #[test]
    fn unsupported_format_is_terminal_without_retry() {
        let mut src = source();
        src.opens.push_back(Err(Failure::Fatal(error(
            "unsupported_format",
            "Choose float32 or PCM16/24/32 in Windows output settings",
        ))));
        let (result, _, states) = run(&mut src);
        assert_eq!(result.unwrap_err().code, "unsupported_format");
        assert_eq!(src.log.borrow().opens.len(), 1);
        assert!(!states.contains(&CaptureState::Running));
    }
    #[test]
    fn invalidation_discards_session_and_reopens() {
        let mut src = source();
        let mut lost = session(&src, 48_000, &[0; 8], 0);
        lost.packets.clear();
        lost.invalidated = true;
        src.opens.push_back(Ok(lost));
        src.opens.push_back(Ok(session(&src, 44_100, &[0; 8], 0)));
        src.wakes.extend((0..20).map(|_| Wake::Tick));
        let (result, blocks, states) = run(&mut src);
        result.unwrap();
        assert!(states.contains(&CaptureState::Recovering));
        assert_eq!(blocks[0].format.sample_rate, 44_100);
        assert!(blocks[0].discontinuity);
        assert_eq!(src.log.borrow().drops, 2);
    }
}
