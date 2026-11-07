pub use super::{
    agc::BandNormalizer, features::ChromaExtractor, hpss::HpssSeparator, tracker::BeatTracker,
};
use super::{
    features::{compute_spectral_centroid, compute_spectral_flatness},
    mel::MelBank,
    response::KickOnsetDetector,
    stereo::compute_stereo_metrics,
};
use crate::audio::{snapshot::AnalysisFrame, types::AudioBlock};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;

pub const WINDOW_SIZE: usize = 4096;
pub const HOP_SIZE: usize = 512;
pub const NUM_SPECTRUM_BUCKETS: usize = 64;
pub const NUM_WAVEFORM_SAMPLES: usize = 64;
pub const MIN_FREQ: f32 = 20.0;
pub const DB_FLOOR: f32 = -80.0;

pub struct Analyzer {
    sample_rate: u32,
    fft: Arc<dyn Fft<f32>>,
    hann_window: Vec<f32>,
    channel_buffers: Vec<Vec<f32>>,
    complex_scratch: Vec<Complex<f32>>,
    fft_scratch: Vec<Complex<f32>>,
    kick_detector: KickOnsetDetector,
    beat_tracker: BeatTracker,
    mel_bank: MelBank,
    mel_normalizer: BandNormalizer,
    primary_normalizer: BandNormalizer,
    hpss: HpssSeparator,
    chroma_extractor: ChromaExtractor,
    latest_frame: AnalysisFrame,
    elapsed_ms: f64,
}

impl Analyzer {
    pub fn new(sample_rate: u32) -> Self {
        let mut planner = FftPlanner::new();
        let fft = planner.plan_fft_forward(WINDOW_SIZE);
        let scratch_len = fft.get_inplace_scratch_len();

        let hann_window: Vec<f32> = (0..WINDOW_SIZE)
            .map(|i| {
                0.5 * (1.0
                    - (2.0 * std::f32::consts::PI * (i as f32) / (WINDOW_SIZE as f32 - 1.0)).cos())
            })
            .collect();

        let mel_bank = MelBank::new(
            sample_rate,
            WINDOW_SIZE,
            NUM_SPECTRUM_BUCKETS,
            MIN_FREQ,
            20000.0,
        );
        let mel_normalizer = BandNormalizer::new(NUM_SPECTRUM_BUCKETS, 1.5, 1.4);
        let primary_normalizer = BandNormalizer::new(4, 1.5, 1.4);
        let chroma_extractor = ChromaExtractor::new(sample_rate, WINDOW_SIZE);

        Self {
            sample_rate,
            fft,
            hann_window,
            channel_buffers: Vec::new(),
            complex_scratch: vec![Complex::new(0.0, 0.0); WINDOW_SIZE],
            fft_scratch: vec![Complex::new(0.0, 0.0); scratch_len],
            kick_detector: KickOnsetDetector::default(),
            beat_tracker: BeatTracker::default(),
            mel_bank,
            mel_normalizer,
            primary_normalizer,
            hpss: HpssSeparator::default(),
            chroma_extractor,
            latest_frame: AnalysisFrame::default(),
            elapsed_ms: 0.0,
        }
    }

    pub fn reset(&mut self, sample_rate: u32) {
        if self.sample_rate != sample_rate {
            self.sample_rate = sample_rate;
            let mut planner = FftPlanner::new();
            self.fft = planner.plan_fft_forward(WINDOW_SIZE);
            self.fft_scratch = vec![Complex::new(0.0, 0.0); self.fft.get_inplace_scratch_len()];
            self.mel_bank = MelBank::new(
                sample_rate,
                WINDOW_SIZE,
                NUM_SPECTRUM_BUCKETS,
                MIN_FREQ,
                20000.0,
            );
            self.chroma_extractor = ChromaExtractor::new(sample_rate, WINDOW_SIZE);
        }
        for buf in &mut self.channel_buffers {
            buf.clear();
        }
        self.kick_detector.reset();
        self.beat_tracker.reset();
        self.mel_normalizer.reset();
        self.primary_normalizer.reset();
        self.hpss.reset();
        self.latest_frame = AnalysisFrame::default();
        self.elapsed_ms = 0.0;
    }

    pub fn latest(&self) -> AnalysisFrame {
        self.latest_frame.clone()
    }

    pub fn mel_normalizer(&self) -> &BandNormalizer {
        &self.mel_normalizer
    }

    pub fn primary_normalizer(&self) -> &BandNormalizer {
        &self.primary_normalizer
    }

    pub fn kick_detector(&self) -> &KickOnsetDetector {
        &self.kick_detector
    }

    pub fn beat_tracker(&self) -> &BeatTracker {
        &self.beat_tracker
    }

    pub fn hpss(&self) -> &HpssSeparator {
        &self.hpss
    }

    pub fn chroma_extractor(&self) -> &ChromaExtractor {
        &self.chroma_extractor
    }

    pub fn push(&mut self, block: &AudioBlock) {
        if block.discontinuity || block.format.sample_rate != self.sample_rate {
            self.reset(block.format.sample_rate);
        }

        let channels = block.format.channels.max(1) as usize;
        if self.channel_buffers.len() != channels {
            self.channel_buffers = vec![Vec::with_capacity(WINDOW_SIZE * 2); channels];
        }

        let total_samples = block.samples.len();
        let frames = total_samples / channels;
        if frames == 0 {
            return;
        }

        // De-interleave into channel buffers
        for f in 0..frames {
            for c in 0..channels {
                let sample = block.samples[f * channels + c];
                self.channel_buffers[c].push(if sample.is_finite() { sample } else { 0.0 });
            }
        }

        self.elapsed_ms += (frames as f64 * 1000.0) / (self.sample_rate as f64);

        // Check overall RMS and Peak across the incoming block
        let (rms, peak) = super::levels::levels(&block.samples);
        let stereo_metrics = compute_stereo_metrics(&block.samples, channels);

        if peak <= 1e-7 || rms <= 1e-7 {
            self.kick_detector.process(0.0, self.elapsed_ms);
            self.hpss.process_frame(&[0.0; NUM_SPECTRUM_BUCKETS]);
            let hop_dt = HOP_SIZE as f32 / self.sample_rate as f32;
            self.beat_tracker.push_onset(0.0, false, hop_dt);
            self.latest_frame = AnalysisFrame {
                rms: 0.0,
                peak: 0.0,
                sub_bass: 0.0,
                kick: 0.0,
                mids: 0.0,
                treble: 0.0,
                bands: [0.0; 3],
                spectrum: vec![0.0; NUM_SPECTRUM_BUCKETS],
                waveform: vec![0.0; NUM_WAVEFORM_SAMPLES],
                transient: 0.0,
                flux: 0.0,
                beat: false,
                phase: self.beat_tracker.phase(),
                bpm: self.beat_tracker.bpm(),
                confidence: self.beat_tracker.confidence(),
                h_energy: 0.0,
                p_energy: 0.0,
                chroma: [0.0; 12],
                centroid: 0.0,
                flatness: 0.0,
                stereo_width: 0.0,
                left_peak: 0.0,
                right_peak: 0.0,
                ..Default::default()
            };
            return;
        }

        // Keep rolling buffer bounded
        if self.channel_buffers[0].len() > WINDOW_SIZE * 2 {
            let excess = self.channel_buffers[0].len() - WINDOW_SIZE * 2;
            for buf in &mut self.channel_buffers {
                buf.drain(0..excess);
            }
        }

        // If we don't have enough frames for a full window yet, calculate levels only
        if self.channel_buffers[0].len() < WINDOW_SIZE {
            self.latest_frame.rms = rms;
            self.latest_frame.peak = peak;
            self.latest_frame.left_peak = stereo_metrics.left_peak;
            self.latest_frame.right_peak = stereo_metrics.right_peak;
            self.latest_frame.stereo_width = stereo_metrics.stereo_width;
            return;
        }

        while self.channel_buffers[0].len() >= WINDOW_SIZE {
            // Compute power spectrum averaged across channels
            let num_bins = WINDOW_SIZE / 2 + 1;
            let mut power_spectrum = vec![0.0f32; num_bins];

            for c in 0..channels {
                let buf = &self.channel_buffers[c];
                for (i, &sample) in buf.iter().enumerate().take(WINDOW_SIZE) {
                    self.complex_scratch[i] = Complex::new(sample * self.hann_window[i], 0.0);
                }

                self.fft
                    .process_with_scratch(&mut self.complex_scratch, &mut self.fft_scratch);

                for (k, power) in power_spectrum.iter_mut().enumerate().take(num_bins) {
                    let p = self.complex_scratch[k].norm_sqr();
                    *power += p / (channels as f32);
                }
            }

            // Magnitude spectrum normalized such that a full-scale peak 1.0 sine corresponds to 1.0
            let norm_factor = 4.0 / (WINDOW_SIZE as f32);
            let magnitudes: Vec<f32> = power_spectrum
                .iter()
                .map(|&p| p.sqrt() * norm_factor)
                .collect();

            let hop_dt = HOP_SIZE as f32 / self.sample_rate as f32;

            // Compute 64-band Mel filterbank mapping with A-weighting and AGC normalization
            let mel_dbs = self.mel_bank.compute_dbs(&magnitudes);
            let mel = self.mel_normalizer.process(&mel_dbs, hop_dt);
            let (h_energy, p_energy) = self.hpss.process_frame(&mel);

            // Compute 64 log-frequency buckets in [20 Hz, Nyquist]
            let nyquist = (self.sample_rate as f32 / 2.0).max(MIN_FREQ + 1.0);
            let max_freq = nyquist.min(20000.0);
            let mut spectrum = vec![0.0f32; NUM_SPECTRUM_BUCKETS];

            let bin_resolution = self.sample_rate as f32 / WINDOW_SIZE as f32;

            for (b, bucket) in spectrum.iter_mut().enumerate().take(NUM_SPECTRUM_BUCKETS) {
                let f_low =
                    MIN_FREQ * (max_freq / MIN_FREQ).powf(b as f32 / NUM_SPECTRUM_BUCKETS as f32);
                let f_high = MIN_FREQ
                    * (max_freq / MIN_FREQ).powf((b + 1) as f32 / NUM_SPECTRUM_BUCKETS as f32);

                let k_low = ((f_low / bin_resolution).floor() as usize).min(num_bins - 1);
                let k_high = ((f_high / bin_resolution).ceil() as usize)
                    .min(num_bins)
                    .max(k_low + 1);

                let mut max_mag = 0.0f32;
                for &m in magnitudes.iter().take(k_high).skip(k_low) {
                    if m > max_mag {
                        max_mag = m;
                    }
                }

                *bucket = mag_to_normalized_db(max_mag);
            }

            // Compute bands and sub-bands:
            // Sub-bass: 20 Hz - 70 Hz
            // Kick: 70 Hz - 160 Hz
            // Bass: 20 Hz - 250 Hz (represented in bands[0] as sub_bass + kick)
            // Mid: 250 Hz - 4000 Hz
            // Treble: 4000 Hz - Nyquist
            let k_sub_bass_start = ((20.0 / bin_resolution).floor() as usize)
                .max(1)
                .min(num_bins - 1);
            let k_sub_bass_end = ((70.0 / bin_resolution).round() as usize)
                .min(num_bins)
                .max(k_sub_bass_start + 1);

            let k_kick_start = k_sub_bass_end;
            let k_kick_end = ((160.0 / bin_resolution).round() as usize)
                .min(num_bins)
                .max(k_kick_start + 1);

            let k_bass_end = ((250.0 / bin_resolution).round() as usize)
                .min(num_bins)
                .max(k_kick_end);
            let k_mid_end = ((4000.0 / bin_resolution).round() as usize)
                .min(num_bins)
                .max(k_bass_end);

            let sub_bass_mag = max_in_range(&magnitudes[k_sub_bass_start..k_sub_bass_end]);
            let kick_mag = max_in_range(&magnitudes[k_kick_start..k_kick_end]);
            let mid_mag = max_in_range(&magnitudes[k_bass_end..k_mid_end]);
            let treble_mag = max_in_range(&magnitudes[k_mid_end..]);

            let primary_dbs = [
                super::agc::mag_to_db(sub_bass_mag),
                super::agc::mag_to_db(kick_mag),
                super::agc::mag_to_db(mid_mag),
                super::agc::mag_to_db(treble_mag),
            ];
            let primary_norm = self.primary_normalizer.process(&primary_dbs, hop_dt);
            let sub_bass = primary_norm[0];
            let kick = primary_norm[1];
            let mids = primary_norm[2];
            let treble = primary_norm[3];

            let bands = [(sub_bass + kick).clamp(0.0, 1.0), mids, treble];

            let (is_onset, flux_strength) = self.kick_detector.process(kick, self.elapsed_ms);
            self.beat_tracker
                .push_onset(flux_strength, is_onset, hop_dt);

            let beat = if self.beat_tracker.confidence() > 0.35 {
                self.beat_tracker.is_predictive_beat()
            } else {
                is_onset
            };

            // Downsample the 4096-sample window into 64-sample normalized waveform
            let stride = WINDOW_SIZE / NUM_WAVEFORM_SAMPLES;
            let mut waveform = Vec::with_capacity(NUM_WAVEFORM_SAMPLES);
            for i in 0..NUM_WAVEFORM_SAMPLES {
                let idx = i * stride;
                let mut sum = 0.0f32;
                for c in 0..channels {
                    sum += self.channel_buffers[c][idx];
                }
                let sample = (sum / channels as f32).clamp(-1.0, 1.0);
                waveform.push(sample);
            }

            // Compute Chroma, Spectral Centroid, and Spectral Flatness
            let chroma = self.chroma_extractor.extract(&magnitudes);
            let centroid = compute_spectral_centroid(&magnitudes, self.sample_rate, WINDOW_SIZE);
            let flatness = compute_spectral_flatness(&magnitudes);

            self.latest_frame = AnalysisFrame {
                rms,
                peak,
                sub_bass,
                kick,
                mids,
                treble,
                bands,
                spectrum,
                waveform,
                flux: flux_strength,
                transient: flux_strength,
                beat,
                phase: self.beat_tracker.phase(),
                bpm: self.beat_tracker.bpm(),
                confidence: self.beat_tracker.confidence(),
                mel,
                h_energy,
                p_energy,
                chroma,
                centroid,
                flatness,
                stereo_width: stereo_metrics.stereo_width,
                left_peak: stereo_metrics.left_peak,
                right_peak: stereo_metrics.right_peak,
                ..AnalysisFrame::default()
            };

            // Slide forward by HOP_SIZE
            for buf in &mut self.channel_buffers {
                buf.drain(0..HOP_SIZE);
            }
        }
    }
}

fn max_in_range(slice: &[f32]) -> f32 {
    let mut m = 0.0f32;
    for &x in slice {
        if x > m {
            m = x;
        }
    }
    m
}

fn mag_to_normalized_db(mag: f32) -> f32 {
    if mag <= 1e-5 {
        return 0.0;
    }
    let db = 20.0 * mag.log10();
    ((db - DB_FLOOR) / (-DB_FLOOR)).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::types::AudioFormat;

    fn make_sine_block(
        sample_rate: u32,
        freq: f32,
        amplitude: f32,
        num_samples: usize,
    ) -> AudioBlock {
        let mut samples = Vec::with_capacity(num_samples);
        for i in 0..num_samples {
            let t = i as f32 / sample_rate as f32;
            samples.push(amplitude * (2.0 * std::f32::consts::PI * freq * t).sin());
        }
        AudioBlock {
            format: AudioFormat {
                sample_rate,
                channels: 1,
            },
            samples,
            discontinuity: false,
        }
    }

    #[test]
    fn silence_is_exact_zero() {
        let mut analyzer = Analyzer::new(48000);
        let silence = AudioBlock {
            format: AudioFormat {
                sample_rate: 48000,
                channels: 2,
            },
            samples: vec![0.0; 4096],
            discontinuity: false,
        };
        analyzer.push(&silence);
        let frame = analyzer.latest();

        assert_eq!(frame.rms, 0.0);
        assert_eq!(frame.peak, 0.0);
        assert_eq!(frame.sub_bass, 0.0);
        assert_eq!(frame.kick, 0.0);
        assert_eq!(frame.mids, 0.0);
        assert_eq!(frame.treble, 0.0);
        assert_eq!(frame.bands, [0.0, 0.0, 0.0]);
        assert_eq!(frame.mel, vec![0.0; 64]);
        assert_eq!(frame.spectrum, vec![0.0; 64]);
        assert_eq!(frame.waveform, vec![0.0; 64]);
        assert_eq!(frame.transient, 0.0);
        assert_eq!(frame.flux, 0.0);
        assert!(!frame.beat);
        assert_eq!(frame.h_energy, 0.0);
        assert_eq!(frame.p_energy, 0.0);
    }

    #[test]
    fn mel_bands_populated_on_active_audio() {
        let mut analyzer = Analyzer::new(48000);
        let block = make_sine_block(48000, 1000.0, 0.5, 4096);
        analyzer.push(&block);
        let frame = analyzer.latest();

        assert_eq!(frame.mel.len(), 64);
        assert!(
            frame.mel.iter().any(|&v| v > 0.0),
            "Mel bands should be populated for 1000 Hz tone"
        );
        let peak_band = frame
            .mel
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(idx, _)| idx)
            .unwrap();

        // 1000 Hz falls around band 16-17 out of 64 Mel bands
        assert!(
            (15..=18).contains(&peak_band),
            "Peak mel band for 1000 Hz should be ~16-17, got {peak_band}"
        );
        assert!(frame.mel[peak_band] > frame.mel[0]);
    }

    #[test]
    fn amplitude_half_sine_rms() {
        let mut analyzer = Analyzer::new(48000);
        let block = make_sine_block(48000, 1000.0, 0.5, 4096);
        analyzer.push(&block);
        let frame = analyzer.latest();

        let expected_rms = 0.5 / 2.0f32.sqrt();
        assert!(
            (frame.rms - expected_rms).abs() < 0.005,
            "Expected RMS ~ {}, got {}",
            expected_rms,
            frame.rms
        );
    }

    #[test]
    fn tones_dominate_respective_bands() {
        // 60 Hz tone (Bass: 20-250 Hz)
        let mut bass_analyzer = Analyzer::new(48000);
        bass_analyzer.push(&make_sine_block(48000, 60.0, 0.5, 4096));
        let bass_frame = bass_analyzer.latest();
        assert!(
            bass_frame.bands[0] > bass_frame.bands[1] && bass_frame.bands[0] > bass_frame.bands[2],
            "60 Hz tone must dominate bass band. Bands: {:?}",
            bass_frame.bands
        );

        // 1000 Hz tone (Mid: 250-4000 Hz)
        let mut mid_analyzer = Analyzer::new(48000);
        mid_analyzer.push(&make_sine_block(48000, 1000.0, 0.5, 4096));
        let mid_frame = mid_analyzer.latest();
        assert!(
            mid_frame.bands[1] > mid_frame.bands[0] && mid_frame.bands[1] > mid_frame.bands[2],
            "1000 Hz tone must dominate mid band. Bands: {:?}",
            mid_frame.bands
        );

        // 8000 Hz tone (Treble: 4000-Nyquist Hz)
        let mut treble_analyzer = Analyzer::new(48000);
        treble_analyzer.push(&make_sine_block(48000, 8000.0, 0.5, 4096));
        let treble_frame = treble_analyzer.latest();
        assert!(
            treble_frame.bands[2] > treble_frame.bands[0]
                && treble_frame.bands[2] > treble_frame.bands[1],
            "8000 Hz tone must dominate treble band. Bands: {:?}",
            treble_frame.bands
        );
    }

    #[test]
    fn antiphase_stereo_preserves_energy() {
        let mut analyzer = Analyzer::new(48000);
        let num_frames = 4096;
        let mut stereo_samples = Vec::with_capacity(num_frames * 2);
        for i in 0..num_frames {
            let t = i as f32 / 48000.0;
            let s = 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin();
            stereo_samples.push(s); // Left
            stereo_samples.push(-s); // Right (anti-phase)
        }

        let block = AudioBlock {
            format: AudioFormat {
                sample_rate: 48000,
                channels: 2,
            },
            samples: stereo_samples,
            discontinuity: false,
        };

        analyzer.push(&block);
        let frame = analyzer.latest();

        assert!(
            frame.rms > 0.3,
            "Anti-phase stereo RMS must not cancel. RMS: {}",
            frame.rms
        );
        assert!(
            frame.bands[1] > 0.5,
            "Anti-phase stereo spectral power must not cancel. Mid: {}",
            frame.bands[1]
        );
    }

    #[test]
    fn discontinuity_and_reset_clears_history() {
        let mut analyzer = Analyzer::new(48000);
        analyzer.push(&make_sine_block(48000, 60.0, 0.5, 4096));
        assert!(analyzer.latest().bands[0] > 0.5);

        // Reset
        analyzer.reset(44100);
        let cleared = analyzer.latest();
        assert_eq!(cleared.bands, [0.0, 0.0, 0.0]);
        assert_eq!(cleared.spectrum, vec![0.0; 64]);
        assert_eq!(cleared.waveform, vec![0.0; 64]);
    }

    #[test]
    fn fft_4096_cleanly_separates_40hz_and_60hz_tones_in_sub_bass() {
        let sample_rate = 48000;
        let mut analyzer_40 = Analyzer::new(sample_rate);
        analyzer_40.push(&make_sine_block(sample_rate, 40.0, 0.5, 4096));
        let frame_40 = analyzer_40.latest();

        let mut analyzer_60 = Analyzer::new(sample_rate);
        analyzer_60.push(&make_sine_block(sample_rate, 60.0, 0.5, 4096));
        let frame_60 = analyzer_60.latest();

        // 1. Both tones populate sub_bass (20–70 Hz)
        assert!(
            frame_40.sub_bass > 0.8,
            "40 Hz tone must produce strong sub-bass response: got {}",
            frame_40.sub_bass
        );
        assert!(
            frame_60.sub_bass > 0.8,
            "60 Hz tone must produce strong sub-bass response: got {}",
            frame_60.sub_bass
        );

        // 2. Sub-bass dominates over kick for 40 Hz (sub-bass is >30 dB above kick side-lobes)
        assert!(
            frame_40.sub_bass > frame_40.kick + 0.35,
            "40 Hz sub-bass ({}) must dominate kick ({})",
            frame_40.sub_bass,
            frame_40.kick
        );

        // 3. Peak buckets in 64-band spectrum
        let peak_bin_40 = frame_40
            .spectrum
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(idx, _)| idx)
            .unwrap();

        let peak_bin_60 = frame_60
            .spectrum
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(idx, _)| idx)
            .unwrap();

        // 4. Bins must be distinct and ordered by frequency
        assert!(
            peak_bin_40 < peak_bin_60,
            "40 Hz peak bin ({peak_bin_40}) must be lower than 60 Hz peak bin ({peak_bin_60})"
        );

        // 5. Each tone strictly dominates at its own peak bucket
        assert!(
            frame_40.spectrum[peak_bin_40] > frame_40.spectrum[peak_bin_60],
            "40 Hz tone must have more energy at peak bin {peak_bin_40} than at 60 Hz bin {peak_bin_60}"
        );
        assert!(
            frame_60.spectrum[peak_bin_60] > frame_60.spectrum[peak_bin_40],
            "60 Hz tone must have more energy at peak bin {peak_bin_60} than at 40 Hz bin {peak_bin_40}"
        );

        // 6. Waveforms are populated with 64 samples
        assert_eq!(frame_40.waveform.len(), 64);
        assert_eq!(frame_60.waveform.len(), 64);
        assert!(frame_40.waveform.iter().any(|&s| s.abs() > 0.1));
        assert!(frame_60.waveform.iter().any(|&s| s.abs() > 0.1));
    }

    #[test]
    fn sliding_window_hop_updates_on_hop_size() {
        let sample_rate = 48000;
        let mut analyzer = Analyzer::new(sample_rate);
        // Push initial 4096 samples of 40 Hz to fill the window
        analyzer.push(&make_sine_block(sample_rate, 40.0, 0.5, 4096));
        let frame1 = analyzer.latest();
        assert!(frame1.sub_bass > 0.8);

        // Push 512 samples (one HOP_SIZE) of 1000 Hz tone
        analyzer.push(&make_sine_block(sample_rate, 1000.0, 0.5, 512));
        let frame2 = analyzer.latest();
        // Mid energy should have increased as 1000 Hz entered the sliding window
        assert!(
            frame2.bands[1] > frame1.bands[1],
            "Mid energy should increase after 1000 Hz hop: frame2={:?}, frame1={:?}",
            frame2.bands,
            frame1.bands
        );
    }

    #[test]
    fn test_kick_tone_jump_triggers_beat_and_sets_flux() {
        let sample_rate = 48000;
        let mut analyzer = Analyzer::new(sample_rate);
        // Push 100 Hz tone (kick frequency 70-160 Hz)
        let kick_block = make_sine_block(sample_rate, 100.0, 0.9, 4096);
        analyzer.push(&kick_block);
        let frame = analyzer.latest();
        assert!(
            frame.kick > 0.5,
            "100 Hz must populate kick band: {}",
            frame.kick
        );
        assert!(frame.beat, "Sudden kick jump must trigger beat");
        assert!(frame.flux > 0.0, "Flux must be > 0 on beat: {}", frame.flux);
        assert_eq!(frame.transient, frame.flux);

        // Sustained kick tone over subsequent hops must not re-trigger beat
        analyzer.push(&make_sine_block(sample_rate, 100.0, 0.9, 512));
        let frame2 = analyzer.latest();
        assert!(!frame2.beat, "Sustained tone must not trigger beat");
        assert_eq!(frame2.flux, 0.0);
    }

    #[test]
    fn test_analyzer_hpss_sustained_sine_tone() {
        let sample_rate = 48000;
        let mut analyzer = Analyzer::new(sample_rate);
        // Push continuous samples (4096 window + 15 hops of 512) of 1000 Hz tone to fill HPSS history
        let block = make_sine_block(sample_rate, 1000.0, 0.8, 4096 + 15 * 512);
        analyzer.push(&block);

        let frame = analyzer.latest();
        assert!(
            frame.h_energy > frame.p_energy * 1.8,
            "Sustained 1000 Hz sine should yield dominant h_energy: h={}, p={}",
            frame.h_energy,
            frame.p_energy
        );
        assert!(frame.h_energy > 0.8);
        assert!(frame.p_energy < 0.2);
    }

    #[test]
    fn test_features_and_stereo_fields_populated_without_nan() {
        let sample_rate = 44100;
        let mut analyzer = Analyzer::new(sample_rate);

        // Generate stereo antiphase 440 Hz sine: L = 0.8 * sin, R = -0.8 * sin
        let num_frames = 4096;
        let mut samples = Vec::with_capacity(num_frames * 2);
        for i in 0..num_frames {
            let t = i as f32 / sample_rate as f32;
            let s = 0.8 * (2.0 * std::f32::consts::PI * 440.0 * t).sin();
            samples.push(s);
            samples.push(-s);
        }

        let block = AudioBlock {
            format: AudioFormat {
                sample_rate,
                channels: 2,
            },
            samples,
            discontinuity: false,
        };

        analyzer.push(&block);
        let frame = analyzer.latest();

        // Check non-NaN and valid ranges
        assert!(!frame.centroid.is_nan(), "Centroid must not be NaN");
        assert!(!frame.flatness.is_nan(), "Flatness must not be NaN");
        assert!(!frame.stereo_width.is_nan(), "Stereo width must not be NaN");
        assert!(!frame.left_peak.is_nan(), "Left peak must not be NaN");
        assert!(!frame.right_peak.is_nan(), "Right peak must not be NaN");

        assert!(
            frame.centroid > 0.0 && frame.centroid < 1.0,
            "Centroid should be in (0, 1): {}",
            frame.centroid
        );
        assert!(
            frame.flatness < 0.05,
            "Flatness for 440 Hz sine must be < 0.05: {}",
            frame.flatness
        );
        assert!(
            frame.stereo_width > 0.95,
            "Stereo width for antiphase must be > 0.95: {}",
            frame.stereo_width
        );
        assert!(
            frame.left_peak > 0.7,
            "Left peak must be > 0.7: {}",
            frame.left_peak
        );
        assert!(
            frame.right_peak > 0.7,
            "Right peak must be > 0.7: {}",
            frame.right_peak
        );

        for (pitch, &val) in frame.chroma.iter().enumerate() {
            assert!(!val.is_nan(), "Chroma bin {} must not be NaN", pitch);
            assert!(
                (0.0..=1.0).contains(&val),
                "Chroma bin {} out of [0, 1]: {}",
                pitch,
                val
            );
        }

        // 440 Hz is pitch class 9 (A)
        assert!(
            frame.chroma[9] > 0.9,
            "Chroma pitch class 9 (A) must dominate for 440 Hz tone: {}",
            frame.chroma[9]
        );

        // Verify silence block zeroes all feature fields cleanly
        let silence_block = AudioBlock {
            format: AudioFormat {
                sample_rate,
                channels: 2,
            },
            samples: vec![0.0; 4096 * 2],
            discontinuity: false,
        };
        analyzer.push(&silence_block);
        let silence_frame = analyzer.latest();

        assert_eq!(silence_frame.centroid, 0.0);
        assert_eq!(silence_frame.flatness, 0.0);
        assert_eq!(silence_frame.stereo_width, 0.0);
        assert_eq!(silence_frame.left_peak, 0.0);
        assert_eq!(silence_frame.right_peak, 0.0);
        assert_eq!(silence_frame.chroma, [0.0; 12]);
    }
}
