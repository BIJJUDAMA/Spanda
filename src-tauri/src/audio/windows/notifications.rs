use super::loopback::native_error;
use crate::audio::types::CaptureError;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use windows::{
    core::{implement, PCWSTR},
    Win32::{
        Foundation::{CloseHandle, HANDLE, PROPERTYKEY, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
        Media::Audio::{
            eMultimedia, eRender, EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
            IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
        },
        System::{
            Com::{CoCreateInstance, CLSCTX_ALL},
            Threading::{CreateEventW, SetEvent, WaitForMultipleObjects},
        },
    },
};

pub(super) struct Event(HANDLE);

// Kernel event handles support concurrent SetEvent/wait. The Arc owner keeps
// each handle alive until both the worker and in-flight callbacks release it.
unsafe impl Send for Event {}
unsafe impl Sync for Event {}

impl Event {
    pub(super) fn new(manual: bool) -> Result<Self, CaptureError> {
        // Unnamed, non-inheritable event, initially nonsignaled.
        unsafe { CreateEventW(None, manual, false, None) }
            .map(Self)
            .map_err(|e| native_error("create_event", e))
    }
    pub(super) fn handle(&self) -> HANDLE {
        self.0
    }
    fn signal(&self) {
        // Atomic flags plus bounded waits preserve detection if signaling fails.
        let _ = unsafe { SetEvent(self.0) };
    }
}
impl Drop for Event {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub(super) struct Signals {
    stopped: AtomicBool,
    changed: AtomicBool,
    stop_event: Event,
    change_event: Event,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum WakeReason {
    Stop,
    DeviceChange,
    Audio,
    Timeout,
}

impl Signals {
    pub(super) fn new() -> Result<Self, CaptureError> {
        Ok(Self {
            stopped: AtomicBool::new(false),
            changed: AtomicBool::new(false),
            stop_event: Event::new(true)?,
            change_event: Event::new(false)?,
        })
    }
    pub(super) fn device_changed(&self) {
        if !self.changed.swap(true, Ordering::AcqRel) {
            self.change_event.signal();
        }
    }
    pub(super) fn request_stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.stop_event.signal();
    }
    pub(super) fn cancelled(&self, stop: &AtomicBool) -> bool {
        self.stopped.load(Ordering::Acquire) || stop.load(Ordering::Acquire)
    }
    pub(super) fn take_change(&self) -> bool {
        self.changed.swap(false, Ordering::AcqRel)
    }
    pub(super) fn has_change(&self) -> bool {
        self.changed.load(Ordering::Acquire)
    }

    pub(super) fn wait(
        &self,
        audio: Option<&Event>,
        timeout: Duration,
    ) -> Result<WakeReason, CaptureError> {
        let handles = [
            self.stop_event.handle(),
            self.change_event.handle(),
            audio.map_or(HANDLE::default(), Event::handle),
        ];
        let count = if audio.is_some() { 3 } else { 2 };
        // Stop has priority. The timeout also bounds AtomicBool-only callers.
        let result = unsafe {
            WaitForMultipleObjects(&handles[..count], false, timeout.as_millis().min(50) as u32)
        };
        if result == WAIT_TIMEOUT {
            Ok(WakeReason::Timeout)
        } else if result == WAIT_OBJECT_0 {
            Ok(WakeReason::Stop)
        } else if result.0 == WAIT_OBJECT_0.0 + 1 {
            Ok(WakeReason::DeviceChange)
        } else if audio.is_some() && result.0 == WAIT_OBJECT_0.0 + 2 {
            Ok(WakeReason::Audio)
        } else if result == WAIT_FAILED {
            Err(native_error("wait", windows::core::Error::from_thread()))
        } else {
            Err(CaptureError {
                code: "wait".into(),
                message: format!("Unexpected audio wait result: {}", result.0),
            })
        }
    }
}

#[implement(IMMNotificationClient)]
struct NotificationClient {
    signals: Arc<Signals>,
}

impl IMMNotificationClient_Impl for NotificationClient_Impl {
    fn OnDefaultDeviceChanged(
        &self,
        flow: EDataFlow,
        role: ERole,
        _id: &PCWSTR,
    ) -> windows::core::Result<()> {
        if flow == eRender && role == eMultimedia {
            self.signals.device_changed();
        }
        // Includes NULL default IDs; never dereference or retain callback IDs.
        Ok(())
    }
    fn OnDeviceStateChanged(
        &self,
        _id: &PCWSTR,
        _state: DEVICE_STATE,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnDeviceAdded(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnPropertyValueChanged(
        &self,
        _id: &PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

pub(super) struct Registration {
    pub(super) enumerator: IMMDeviceEnumerator,
    callback: IMMNotificationClient,
}

impl Registration {
    pub(super) fn new(signals: Arc<Signals>) -> Result<Self, CaptureError> {
        let enumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
            .map_err(|e| native_error("enumerate_outputs", e))?;
        Self::register(enumerator, signals)
    }
    fn register(
        enumerator: IMMDeviceEnumerator,
        signals: Arc<Signals>,
    ) -> Result<Self, CaptureError> {
        let callback: IMMNotificationClient = NotificationClient { signals }.into();
        unsafe { enumerator.RegisterEndpointNotificationCallback(&callback) }
            .map_err(|e| native_error("register_notifications", e))?;
        Ok(Self {
            enumerator,
            callback,
        })
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        // Outside callbacks, before releasing the callback/enumerator and COM.
        let _ = unsafe {
            self.enumerator
                .UnregisterEndpointNotificationCallback(&self.callback)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::{thread, time::Instant};
    use windows::Win32::Media::Audio::{eCapture, eCommunications, eConsole};
    use windows::{
        core::Ref,
        Win32::{
            Foundation::{E_ACCESSDENIED, E_NOTIMPL},
            Media::Audio::{IMMDevice, IMMDeviceCollection, IMMDeviceEnumerator_Impl},
        },
    };

    #[implement(IMMDeviceEnumerator)]
    struct ErrorEnumerator {
        log: Arc<Mutex<Vec<&'static str>>>,
    }
    impl IMMDeviceEnumerator_Impl for ErrorEnumerator_Impl {
        fn EnumAudioEndpoints(
            &self,
            _: EDataFlow,
            _: DEVICE_STATE,
        ) -> windows::core::Result<IMMDeviceCollection> {
            Err(E_NOTIMPL.into())
        }
        fn GetDefaultAudioEndpoint(
            &self,
            _: EDataFlow,
            _: ERole,
        ) -> windows::core::Result<IMMDevice> {
            self.log.lock().unwrap().push("open_error");
            Err(E_ACCESSDENIED.into())
        }
        fn GetDevice(&self, _: &PCWSTR) -> windows::core::Result<IMMDevice> {
            Err(E_NOTIMPL.into())
        }
        fn RegisterEndpointNotificationCallback(
            &self,
            _: Ref<IMMNotificationClient>,
        ) -> windows::core::Result<()> {
            self.log.lock().unwrap().push("register");
            Ok(())
        }
        fn UnregisterEndpointNotificationCallback(
            &self,
            _: Ref<IMMNotificationClient>,
        ) -> windows::core::Result<()> {
            self.log.lock().unwrap().push("unregister");
            Ok(())
        }
    }
    impl Drop for ErrorEnumerator {
        fn drop(&mut self) {
            self.log.lock().unwrap().push("release_enumerator");
        }
    }

    #[test]
    fn early_open_error_unregisters_before_releasing_com_objects() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let signals = Arc::new(Signals::new().unwrap());
        let early_error = (|| {
            let enumerator: IMMDeviceEnumerator = ErrorEnumerator { log: log.clone() }.into();
            let registration = Registration::register(enumerator, signals.clone())?;
            unsafe {
                registration
                    .enumerator
                    .GetDefaultAudioEndpoint(eRender, eMultimedia)
            }
            .map_err(|e| native_error("default_output", e))?;
            Ok::<(), CaptureError>(())
        })();
        assert_eq!(early_error.unwrap_err().code, "default_output");
        assert_eq!(
            *log.lock().unwrap(),
            ["register", "open_error", "unregister", "release_enumerator"]
        );
        // The callback and its Arc must also have been released on early exit.
        assert_eq!(Arc::strong_count(&signals), 1);
    }

    #[test]
    fn notifications_filter_roles_coalesce_and_accept_null_default() {
        let signals = Arc::new(Signals::new().unwrap());
        let callback: IMMNotificationClient = NotificationClient {
            signals: signals.clone(),
        }
        .into();
        unsafe {
            callback
                .OnDefaultDeviceChanged(eCapture, eMultimedia, PCWSTR::null())
                .unwrap();
            callback
                .OnDefaultDeviceChanged(eRender, eConsole, PCWSTR::null())
                .unwrap();
            callback
                .OnDefaultDeviceChanged(eRender, eCommunications, PCWSTR::null())
                .unwrap();
        }
        assert!(!signals.take_change());
        unsafe {
            callback
                .OnDefaultDeviceChanged(eRender, eMultimedia, PCWSTR::null())
                .unwrap();
            callback
                .OnDefaultDeviceChanged(eRender, eMultimedia, PCWSTR::null())
                .unwrap();
        }
        assert!(signals.take_change());
        assert!(!signals.take_change());
    }

    #[test]
    fn native_stop_event_wakes_silent_and_recovery_waits() {
        for audio in [false, true] {
            let signals = Arc::new(Signals::new().unwrap());
            let wake = signals.clone();
            let event = audio.then(|| Event::new(false).unwrap());
            let (ready, waiting) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || {
                // Prove this worker reached the native idle wait before Stop.
                assert_eq!(
                    wake.wait(event.as_ref(), Duration::from_millis(1)).unwrap(),
                    WakeReason::Timeout
                );
                ready.send(()).unwrap();
                let start = Instant::now();
                loop {
                    let reason = wake.wait(event.as_ref(), Duration::from_secs(10)).unwrap();
                    if reason != WakeReason::Timeout {
                        break (start.elapsed(), reason);
                    }
                    assert!(
                        start.elapsed() < Duration::from_secs(2),
                        "Stop did not wake the idle worker"
                    );
                }
            });
            waiting.recv_timeout(Duration::from_secs(2)).unwrap();
            signals.request_stop();
            let (elapsed, reason) = worker.join().unwrap();
            assert_eq!(reason, WakeReason::Stop);
            assert!(elapsed < Duration::from_millis(500));
        }
    }
}
