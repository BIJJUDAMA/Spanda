use super::{
    analysis::Analyzer,
    capture::CaptureState,
    snapshot::{AnalysisFrame, CaptureSnapshot, UnifiedAnalysisFrame},
    types::{AudioBlock, CaptureError},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

type Run = Box<dyn FnOnce(Publisher) -> Result<(), CaptureError> + Send>;
pub struct Session {
    pub run: Run,
    pub stop: Box<dyn Fn() + Send>,
}
type Factory = dyn Fn() -> Result<Session, CaptureError> + Send + Sync;

struct Worker {
    capture_join: JoinHandle<Result<(), CaptureError>>,
    analysis_join: JoinHandle<()>,
    analysis_stopped: Arc<AtomicBool>,
    stop: Box<dyn Fn() + Send>,
}

#[derive(Default)]
struct Owner {
    worker: Option<Worker>,
    closed: bool,
}

#[derive(Default)]
struct Latest {
    snapshot: CaptureSnapshot,
    last_packet: Option<Instant>,
}

#[derive(Clone)]
pub struct Publisher {
    latest: Arc<Mutex<Latest>>,
    generation: u32,
    analysis_tx: SyncSender<AudioBlock>,
    recording: Arc<crate::recording::RecordingTap>,
    dropped_flag: Arc<AtomicBool>,
}

impl Publisher {
    pub fn state(&self, state: CaptureState) {
        if !matches!(
            state,
            CaptureState::Starting | CaptureState::Running | CaptureState::Recovering
        ) {
            return;
        }
        let mut latest = self.latest.lock().unwrap();
        if !self.accepts(&latest) {
            return;
        }
        if latest.snapshot.state != state {
            latest.snapshot.state = state;
            clear_diagnostics(&mut latest);
            latest.snapshot.sequence += 1;
        }
    }

    fn accepts(&self, latest: &Latest) -> bool {
        latest.snapshot.generation == self.generation
            && matches!(
                latest.snapshot.state,
                CaptureState::Starting | CaptureState::Running | CaptureState::Recovering
            )
    }

    pub fn block(&self, block: &AudioBlock) {
        self.recording.push(block);
        let mut block_to_send = block.clone();
        if self.dropped_flag.swap(false, Ordering::AcqRel) {
            block_to_send.discontinuity = true;
        }
        match self.analysis_tx.try_send(block_to_send) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped_flag.store(true, Ordering::Release);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

pub type FrameEmitter = Arc<dyn Fn(UnifiedAnalysisFrame) + Send + Sync>;

pub struct CaptureService {
    owner: Mutex<Owner>,
    latest: Arc<Mutex<Latest>>,
    factory: Box<Factory>,
    pub recording: Arc<crate::recording::RecordingTap>,
    emitter: Arc<Mutex<Option<FrameEmitter>>>,
}

impl CaptureService {
    pub fn new() -> Self {
        Self::with_factory(native_session)
    }

    pub fn with_factory(
        factory: impl Fn() -> Result<Session, CaptureError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            owner: Mutex::new(Owner::default()),
            latest: Arc::new(Mutex::new(Latest::default())),
            factory: Box::new(factory),
            recording: Arc::default(),
            emitter: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_emitter(&self, emitter: impl Fn(UnifiedAnalysisFrame) + Send + Sync + 'static) {
        let mut guard = self.emitter.lock().unwrap();
        *guard = Some(Arc::new(emitter));
    }

    pub fn clear_emitter(&self) {
        let mut guard = self.emitter.lock().unwrap();
        *guard = None;
    }

    pub fn start(&self) -> Result<(), CaptureError> {
        let mut owner = self.owner.lock().unwrap();
        self.reap(&mut owner);
        if owner.closed {
            return Err(error("closed", "Capture is shutting down."));
        }
        if owner.worker.is_some() {
            return Ok(());
        }
        let generation = {
            let mut latest = self.latest.lock().unwrap();
            latest.snapshot.generation = latest
                .snapshot
                .generation
                .checked_add(1)
                .ok_or_else(|| error("generation_limit", "Restart Spanda to capture again."))?;
            latest.snapshot.sequence = 1;
            latest.snapshot.state = CaptureState::Starting;
            latest.snapshot.error = None;
            clear_diagnostics(&mut latest);
            latest.snapshot.generation
        };

        let session = match (self.factory)() {
            Ok(s) => s,
            Err(e) => {
                self.failed(e.clone());
                return Err(e);
            }
        };

        let (analysis_tx, analysis_rx) = mpsc::sync_channel::<AudioBlock>(4);
        let dropped_flag = Arc::new(AtomicBool::new(false));
        let analysis_stopped = Arc::new(AtomicBool::new(false));
        let analysis_stopped_clone = analysis_stopped.clone();
        let publish = Publisher {
            latest: self.latest.clone(),
            generation,
            analysis_tx,
            recording: self.recording.clone(),
            dropped_flag,
        };

        let latest_for_analysis = self.latest.clone();
        let emitter_arc = self.emitter.clone();
        let analysis_join =
            match thread::Builder::new()
                .name("audio-analysis".into())
                .spawn(move || {
                    let mut analyzer = Analyzer::new(48000);
                    let mut last_push = Instant::now()
                        .checked_sub(Duration::from_millis(16))
                        .unwrap_or_else(Instant::now);
                    let mut max_peak: f32 = 0.0;
                    let mut max_transient: f32 = 0.0;
                    let mut has_unpushed_block = false;

                    while !analysis_stopped_clone.load(Ordering::Acquire) {
                        let timeout = if has_unpushed_block {
                            let elapsed = last_push.elapsed();
                            if elapsed >= Duration::from_millis(16) {
                                Duration::from_millis(0)
                            } else {
                                Duration::from_millis(16) - elapsed
                            }
                        } else {
                            Duration::from_millis(50)
                        };

                        match analysis_rx.recv_timeout(timeout) {
                            Ok(block) => {
                                analyzer.push(&block);
                                let frame = analyzer.latest();
                                max_peak = max_peak.max(frame.peak);
                                max_transient = max_transient.max(frame.transient);
                                has_unpushed_block = true;

                                let mut latest = latest_for_analysis.lock().unwrap();
                                if latest.snapshot.generation == generation
                                    && matches!(
                                        latest.snapshot.state,
                                        CaptureState::Starting
                                            | CaptureState::Running
                                            | CaptureState::Recovering
                                    )
                                {
                                    latest.snapshot.sample_rate = Some(block.format.sample_rate);
                                    latest.snapshot.channels = Some(block.format.channels);
                                    latest.snapshot.silent = frame.peak <= 1e-7;
                                    let mut snap_frame = frame;
                                    snap_frame.peak = snap_frame.peak.max(max_peak);
                                    snap_frame.transient = snap_frame.transient.max(max_transient);
                                    latest.snapshot.analysis = snap_frame;
                                    latest.last_packet = Some(Instant::now());
                                    latest.snapshot.sequence += 1;
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }

                        if has_unpushed_block && last_push.elapsed() >= Duration::from_millis(16) {
                            let mut push_frame = analyzer.latest();
                            push_frame.peak = max_peak;
                            push_frame.transient = max_transient;

                            let emitter_opt = emitter_arc.lock().unwrap().clone();
                            if let Some(ref emit) = emitter_opt {
                                emit(push_frame);
                            }

                            max_peak = 0.0;
                            max_transient = 0.0;
                            has_unpushed_block = false;
                            last_push = Instant::now();
                        }
                    }
                }) {
                Ok(handle) => handle,
                Err(e) => {
                    let err = error(
                        "worker_spawn",
                        &format!("Could not start analysis worker: {e}"),
                    );
                    self.failed(err.clone());
                    return Err(err);
                }
            };

        match thread::Builder::new()
            .name("audio-capture".into())
            .spawn(move || (session.run)(publish))
        {
            Ok(capture_join) => {
                let stop_session = session.stop;
                let analysis_stop_flag = analysis_stopped.clone();
                let stop = Box::new(move || {
                    analysis_stopped.store(true, Ordering::Release);
                    (stop_session)();
                });
                owner.worker = Some(Worker {
                    capture_join,
                    analysis_join,
                    analysis_stopped: analysis_stop_flag,
                    stop,
                });
                Ok(())
            }
            Err(e) => {
                let err = error(
                    "worker_spawn",
                    &format!("Could not start capture worker: {e}"),
                );
                self.failed(err.clone());
                analysis_stopped.store(true, Ordering::Release);
                let _ = analysis_join.join();
                Err(err)
            }
        }
    }

    pub fn stop(&self) -> Result<(), CaptureError> {
        let mut owner = self.owner.lock().unwrap();
        self.stop_owned(&mut owner);
        Ok(())
    }

    pub fn shutdown(&self) -> Result<(), CaptureError> {
        let mut owner = self.owner.lock().unwrap();
        owner.closed = true;
        self.stop_owned(&mut owner);
        Ok(())
    }

    fn stop_owned(&self, owner: &mut Owner) {
        if let Some(worker) = owner.worker.take() {
            {
                let mut latest = self.latest.lock().unwrap();
                latest.snapshot.state = CaptureState::Stopping;
                clear_diagnostics(&mut latest);
                latest.snapshot.sequence += 1;
            }
            (worker.stop)();
            // All workers are joined off the UI thread without holding the snapshot lock.
            let _ = worker.capture_join.join();
            let _ = worker.analysis_join.join();
        }
        let mut latest = self.latest.lock().unwrap();
        latest.snapshot.state = CaptureState::Idle;
        latest.snapshot.error = None;
        clear_diagnostics(&mut latest);
        latest.snapshot.sequence += 1;
    }

    fn failed(&self, error: CaptureError) {
        let mut latest = self.latest.lock().unwrap();
        latest.snapshot.state = CaptureState::Error;
        latest.snapshot.error = Some(error);
        clear_diagnostics(&mut latest);
        latest.snapshot.sequence += 1;
    }

    fn reap(&self, owner: &mut Owner) {
        if owner
            .worker
            .as_ref()
            .is_some_and(|w| w.capture_join.is_finished())
        {
            let worker = owner.worker.take().unwrap();
            let failure = match worker.capture_join.join() {
                Ok(Err(e)) => e,
                Ok(Ok(())) => error(
                    "unexpected_exit",
                    "Capture ended unexpectedly. Press Start to retry.",
                ),
                Err(_) => error(
                    "worker_panic",
                    "Capture failed unexpectedly. Press Start to retry.",
                ),
            };
            worker.analysis_stopped.store(true, Ordering::Release);
            let _ = worker.analysis_join.join();
            self.failed(failure);
        }
    }

    pub fn snapshot(&self) -> CaptureSnapshot {
        let mut owner = self.owner.lock().unwrap();
        self.reap(&mut owner);
        let mut latest = self.latest.lock().unwrap();
        if latest
            .last_packet
            .is_some_and(|time| time.elapsed() >= Duration::from_millis(250))
        {
            latest.snapshot.analysis = AnalysisFrame::default();
            latest.snapshot.silent = true;
            latest.last_packet = None;
            latest.snapshot.sequence += 1;
        }
        latest.snapshot.clone()
    }
}

impl Default for CaptureService {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CaptureService {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn clear_diagnostics(latest: &mut Latest) {
    latest.snapshot.device_name = None;
    latest.snapshot.sample_rate = None;
    latest.snapshot.channels = None;
    latest.snapshot.analysis = AnalysisFrame::default();
    latest.snapshot.silent = true;
    latest.last_packet = None;
}

fn error(code: &str, message: &str) -> CaptureError {
    CaptureError {
        code: code.into(),
        message: message.into(),
    }
}

fn native_session() -> Result<Session, CaptureError> {
    #[cfg(windows)]
    {
        let mut adapter = super::windows::WindowsWasapiCapture::new()?;
        let handle = adapter.stop_handle();
        Ok(Session {
            stop: Box::new(move || handle.stop()),
            run: Box::new(move |publish| {
                adapter.run_with_state(
                    &std::sync::atomic::AtomicBool::new(false),
                    &mut |block| publish.block(block),
                    &mut |state| publish.state(state),
                )
            }),
        })
    }
    #[cfg(not(windows))]
    {
        Err(CaptureError {
            code: "unsupported_platform".into(),
            message: "System capture currently requires Windows.".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::AudioFormat;
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    };

    fn fake() -> (CaptureService, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let active = Arc::new(AtomicUsize::new(0));
        let opened = Arc::new(AtomicUsize::new(0));
        let (a, o) = (active.clone(), opened.clone());
        let service = CaptureService::with_factory(move || {
            o.fetch_add(1, Ordering::SeqCst);
            let stopped = Arc::new(AtomicBool::new(false));
            let stop = stopped.clone();
            let active = a.clone();
            Ok(Session {
                stop: Box::new(move || stop.store(true, Ordering::Release)),
                run: Box::new(move |p| {
                    active.fetch_add(1, Ordering::SeqCst);
                    p.state(CaptureState::Running);
                    while !stopped.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_millis(1));
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                }),
            })
        });
        (service, active, opened)
    }

    fn until(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !predicate() {
            assert!(Instant::now() < deadline, "condition timed out");
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn startup_does_not_capture() {
        let (s, active, opened) = fake();
        assert_eq!(s.snapshot().state, CaptureState::Idle);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(opened.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn double_start_has_one_worker() {
        let (s, active, opened) = fake();
        s.start().unwrap();
        s.start().unwrap();
        until(|| active.load(Ordering::SeqCst) == 1);
        assert_eq!(opened.load(Ordering::SeqCst), 1);
        assert_eq!(s.snapshot().generation, 1);
        s.stop().unwrap();
        assert_eq!(active.load(Ordering::SeqCst), 0);
        s.start().unwrap();
        assert_eq!(s.snapshot().generation, 2);
        s.stop().unwrap();
    }

    #[test]
    fn stop_during_open_does_not_resurrect() {
        let (tx, rx) = mpsc::channel();
        let rx = Mutex::new(Some(rx));
        let s = Arc::new(CaptureService::with_factory(move || {
            let rx = rx.lock().unwrap().take().unwrap();
            Ok(Session {
                stop: Box::new(|| {}),
                run: Box::new(move |p| {
                    rx.recv().unwrap();
                    p.state(CaptureState::Running);
                    Ok(())
                }),
            })
        }));
        s.start().unwrap();
        let other = s.clone();
        let stop = thread::spawn(move || other.stop());
        until(|| s.latest.lock().unwrap().snapshot.state == CaptureState::Stopping);
        tx.send(()).unwrap();
        stop.join().unwrap().unwrap();
        assert_eq!(s.snapshot().state, CaptureState::Idle);
    }

    #[test]
    fn old_generation_cannot_publish() {
        let (s, _, _) = fake();
        s.start().unwrap();
        let (tx, _rx) = mpsc::sync_channel(4);
        let old = Publisher {
            latest: s.latest.clone(),
            generation: 1,
            analysis_tx: tx,
            recording: Arc::default(),
            dropped_flag: Arc::new(AtomicBool::new(false)),
        };
        s.stop().unwrap();
        s.start().unwrap();
        old.state(CaptureState::Recovering);
        old.block(&AudioBlock {
            format: AudioFormat {
                sample_rate: 8_000,
                channels: 1,
            },
            samples: vec![1.0],
            discontinuity: false,
        });
        assert_eq!(s.snapshot().generation, 2);
        assert_eq!(s.snapshot().analysis.peak, 0.0);
        assert_ne!(s.snapshot().state, CaptureState::Recovering);
        s.stop().unwrap();
    }

    #[test]
    fn shutdown_joins_worker() {
        let (s, active, _) = fake();
        s.start().unwrap();
        until(|| active.load(Ordering::SeqCst) == 1);
        s.shutdown().unwrap();
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(s.snapshot().state, CaptureState::Idle);
        assert!(s.start().is_err());
    }

    #[test]
    fn missing_packets_clear_levels() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let s = CaptureService::with_factory(move || {
            let tx = tx.lock().unwrap().clone();
            let stopped = Arc::new(AtomicBool::new(false));
            let stop = stopped.clone();
            Ok(Session {
                stop: Box::new(move || stop.store(true, Ordering::Release)),
                run: Box::new(move |p| {
                    p.state(CaptureState::Running);
                    tx.send(p).unwrap();
                    while !stopped.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Ok(())
                }),
            })
        });
        s.start().unwrap();
        let p = rx.recv().unwrap();
        until(|| s.snapshot().state == CaptureState::Running);

        p.block(&AudioBlock {
            format: AudioFormat {
                sample_rate: 48_000,
                channels: 2,
            },
            samples: vec![0.5, -0.5],
            discontinuity: false,
        });

        until(|| s.snapshot().analysis.rms > 0.0);
        assert!((s.snapshot().analysis.rms - 0.5).abs() < 1e-4);

        s.latest.lock().unwrap().last_packet = Some(Instant::now() - Duration::from_millis(251));
        let snap = s.snapshot();
        assert_eq!(snap.state, CaptureState::Running);
        assert_eq!(snap.analysis.peak, 0.0);
        assert!(snap.silent);
        s.stop().unwrap();
    }

    #[test]
    fn overload_storage_stays_bounded_and_capture_never_waits() {
        let (tx, _rx) = mpsc::sync_channel::<AudioBlock>(4);
        let dropped = Arc::new(AtomicBool::new(false));
        let publ = Publisher {
            latest: Arc::new(Mutex::new(Latest::default())),
            generation: 1,
            analysis_tx: tx,
            recording: Arc::default(),
            dropped_flag: dropped.clone(),
        };

        let block = AudioBlock {
            format: AudioFormat {
                sample_rate: 48000,
                channels: 1,
            },
            samples: vec![0.1; 128],
            discontinuity: false,
        };

        // Send 10 blocks into a capacity-4 channel with no consumer.
        // It must NOT block, and must drop excess blocks and set dropped_flag.
        for _ in 0..10 {
            publ.block(&block);
        }

        assert!(
            dropped.load(Ordering::Acquire),
            "Dropped flag must be set on channel overflow"
        );
    }

    #[test]
    fn failure_is_terminal_only_after_join_and_retry_uses_fresh_session() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let s = CaptureService::with_factory(move || {
            let tx = tx.lock().unwrap().clone();
            Ok(Session {
                stop: Box::new(|| {}),
                run: Box::new(move |p| {
                    p.state(CaptureState::Recovering);
                    tx.send(()).unwrap();
                    Err(CaptureError {
                        code: "test_open".into(),
                        message: "Choose a Windows output, then retry.".into(),
                    })
                }),
            })
        });
        s.start().unwrap();
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        until(|| s.snapshot().state == CaptureState::Error);
        assert!(s.owner.lock().unwrap().worker.is_none());
        assert_eq!(s.snapshot().error.unwrap().code, "test_open");
        s.start().unwrap();
        assert_eq!(s.snapshot().generation, 2);
        s.stop().unwrap();
        assert!(s.snapshot().error.is_none());
    }

    #[test]
    fn emitter_receives_audio_frames() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let s = CaptureService::with_factory(move || {
            let tx = tx.lock().unwrap().clone();
            let stopped = Arc::new(AtomicBool::new(false));
            let stop = stopped.clone();
            Ok(Session {
                stop: Box::new(move || stop.store(true, Ordering::Release)),
                run: Box::new(move |p| {
                    p.state(CaptureState::Running);
                    tx.send(p).unwrap();
                    while !stopped.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Ok(())
                }),
            })
        });

        let (frame_tx, frame_rx) = mpsc::channel();
        s.set_emitter(move |frame| {
            let _ = frame_tx.send(frame);
        });

        s.start().unwrap();
        let p = rx.recv().unwrap();
        until(|| s.snapshot().state == CaptureState::Running);

        p.block(&AudioBlock {
            format: AudioFormat {
                sample_rate: 48_000,
                channels: 2,
            },
            samples: vec![0.8, -0.8],
            discontinuity: false,
        });

        let received = frame_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("should receive frame from emitter");
        assert!((received.rms - 0.8).abs() < 1e-4);
        assert!((received.peak - 0.8).abs() < 1e-4);

        s.clear_emitter();
        s.stop().unwrap();
    }

    #[test]
    fn peak_max_holds_across_blocks_between_pushes() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let s = CaptureService::with_factory(move || {
            let tx = tx.lock().unwrap().clone();
            let stopped = Arc::new(AtomicBool::new(false));
            let stop = stopped.clone();
            Ok(Session {
                stop: Box::new(move || stop.store(true, Ordering::Release)),
                run: Box::new(move |p| {
                    p.state(CaptureState::Running);
                    tx.send(p).unwrap();
                    while !stopped.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Ok(())
                }),
            })
        });

        let (frame_tx, frame_rx) = mpsc::channel();
        s.set_emitter(move |frame| {
            let _ = frame_tx.send(frame);
        });

        s.start().unwrap();
        let p = rx.recv().unwrap();
        until(|| s.snapshot().state == CaptureState::Running);

        // Send first block to establish baseline/consume first push
        p.block(&AudioBlock {
            format: AudioFormat {
                sample_rate: 48_000,
                channels: 1,
            },
            samples: vec![0.1; 128],
            discontinuity: false,
        });
        let _ = frame_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        // Now send a quick spike block (0.95), immediately followed by quiet block (0.05)
        p.block(&AudioBlock {
            format: AudioFormat {
                sample_rate: 48_000,
                channels: 1,
            },
            samples: vec![0.95; 128],
            discontinuity: false,
        });
        p.block(&AudioBlock {
            format: AudioFormat {
                sample_rate: 48_000,
                channels: 1,
            },
            samples: vec![0.05; 128],
            discontinuity: false,
        });

        let frame = frame_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("should receive next 16ms frame");

        // The peak must be max-held at 0.95 across incoming audio blocks
        assert!(
            (frame.peak - 0.95).abs() < 1e-4,
            "Expected peak 0.95, got {}",
            frame.peak
        );

        s.stop().unwrap();
    }
}
