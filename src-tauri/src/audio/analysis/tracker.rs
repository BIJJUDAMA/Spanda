use std::collections::VecDeque;

pub const DEFAULT_BPM: f32 = 120.0;
pub const MIN_BPM: f32 = 60.0;
pub const MAX_BPM: f32 = 180.0;
pub const WINDOW_DURATION_SEC: f32 = 6.0;
pub const KP: f32 = 0.18;

/// Wrap angle in radians into [-pi, pi).
#[inline]
pub fn wrap_pi(x: f32) -> f32 {
    let two_pi = std::f32::consts::TAU;
    (x + std::f32::consts::PI).rem_euclid(two_pi) - std::f32::consts::PI
}

/// Predictive Beat Tracker using 6-second onset autocorrelation and a Phase-Locked Loop (PLL).
#[derive(Debug, Clone)]
pub struct BeatTracker {
    onset_buffer: VecDeque<f32>,
    phase: f32,
    bpm: f32,
    period: f32,
    confidence: f32,
    is_predictive_beat: bool,
}

impl BeatTracker {
    pub fn new() -> Self {
        Self {
            onset_buffer: VecDeque::with_capacity(600),
            phase: 0.0,
            bpm: DEFAULT_BPM,
            period: 60.0 / DEFAULT_BPM,
            confidence: 0.0,
            is_predictive_beat: false,
        }
    }

    pub fn reset(&mut self) {
        self.onset_buffer.clear();
        self.phase = 0.0;
        self.bpm = DEFAULT_BPM;
        self.period = 60.0 / DEFAULT_BPM;
        self.confidence = 0.0;
        self.is_predictive_beat = false;
    }

    pub fn phase(&self) -> f32 {
        self.phase
    }

    pub fn bpm(&self) -> f32 {
        self.bpm
    }

    pub fn confidence(&self) -> f32 {
        self.confidence
    }

    pub fn is_predictive_beat(&self) -> bool {
        self.is_predictive_beat
    }

    pub fn period(&self) -> f32 {
        self.period
    }

    /// Update tracker with an incoming onset frame and step the PLL.
    pub fn push_onset(&mut self, onset_strength: f32, is_onset: bool, dt_sec: f32) {
        let dt = if dt_sec.is_finite() && dt_sec > 1e-5 {
            dt_sec
        } else {
            0.01
        };

        // 1. Maintain circular buffer over 6-second window (~400-600 frames)
        let max_frames = ((WINDOW_DURATION_SEC / dt).round() as usize).clamp(100, 1200);
        let strength = if onset_strength.is_finite() {
            onset_strength.max(0.0)
        } else {
            0.0
        };

        self.onset_buffer.push_back(strength);
        while self.onset_buffer.len() > max_frames {
            self.onset_buffer.pop_front();
        }

        // 2. Period Estimation via Autocorrelation across lags corresponding to 60 to 180 BPM
        let min_period_sec = 60.0 / MAX_BPM; // ~0.3333s
        let max_period_sec = 60.0 / MIN_BPM; // ~1.0000s

        let tau_min = ((min_period_sec / dt).floor() as usize).max(2);
        let tau_max = ((max_period_sec / dt).ceil() as usize).max(tau_min + 1);

        let n = self.onset_buffer.len();

        if n >= tau_max {
            let buf = self.onset_buffer.make_contiguous();
            let num_lags = tau_max - tau_min + 1;
            let mut r_values = vec![0.0f32; num_lags];
            let mut sum_r = 0.0f32;
            let mut peak_val = 0.0f32;
            let mut peak_idx = 0usize;

            for (i, tau) in (tau_min..=tau_max).enumerate() {
                let mut sum = 0.0f32;
                for t in tau..n {
                    sum += buf[t] * buf[t - tau];
                }
                r_values[i] = sum;
                sum_r += sum;
                if sum > peak_val {
                    peak_val = sum;
                    peak_idx = i;
                }
            }

            if peak_val <= 1e-5 {
                self.confidence = 0.0;
                self.bpm = DEFAULT_BPM;
                self.period = 60.0 / DEFAULT_BPM;
            } else {
                let mean_r = sum_r / num_lags as f32;
                let prominence = if peak_val > mean_r {
                    (peak_val - mean_r) / peak_val
                } else {
                    0.0
                };

                // Parabolic sub-bin interpolation around primary peak
                let tau_int = tau_min + peak_idx;
                let tau_peak = if peak_idx > 0 && peak_idx + 1 < num_lags {
                    let y0 = r_values[peak_idx - 1];
                    let y1 = r_values[peak_idx];
                    let y2 = r_values[peak_idx + 1];
                    let denom = 2.0 * (y0 - 2.0 * y1 + y2);
                    if denom.abs() > 1e-5 {
                        let delta = (y0 - y2) / denom;
                        (tau_int as f32 + delta.clamp(-1.0, 1.0)).max(tau_min as f32)
                    } else {
                        tau_int as f32
                    }
                } else {
                    tau_int as f32
                };

                let estimated_period = (tau_peak * dt).max(min_period_sec).min(max_period_sec);
                let estimated_bpm = (60.0 / estimated_period).clamp(MIN_BPM, MAX_BPM);

                self.period = estimated_period;
                self.bpm = estimated_bpm;
                self.confidence = prominence.clamp(0.0, 1.0);
            }
        } else {
            self.confidence = 0.0;
        }

        // 3. Phase-Locked Loop (PLL)
        let step = (std::f32::consts::TAU * dt) / self.period;
        let mut new_phase = self.phase + step;
        let mut wrapped = new_phase >= std::f32::consts::TAU;

        if is_onset {
            let unwrapped_phi = new_phase.rem_euclid(std::f32::consts::TAU);
            let err = wrap_pi(-unwrapped_phi);
            let mut corrected = unwrapped_phi + KP * err * self.confidence;
            if wrapped {
                corrected = corrected.max(0.0);
            } else if corrected >= std::f32::consts::TAU {
                wrapped = true;
            }
            new_phase = corrected;
        }

        self.phase = new_phase.rem_euclid(std::f32::consts::TAU);
        self.is_predictive_beat = wrapped;
    }
}

impl Default for BeatTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simulated_120_bpm_pulses_lock() {
        let mut tracker = BeatTracker::new();
        let dt = 0.01; // 100 Hz frame rate
        let total_time = 6.0; // 6 seconds window
        let steps = (total_time / dt) as usize;

        // At 120 BPM, interval is 0.5s -> 50 steps at dt=0.01
        for i in 0..steps {
            let is_beat = (i % 50) == 0;
            let onset_strength = if is_beat { 1.0 } else { 0.0 };
            tracker.push_onset(onset_strength, is_beat, dt);
        }

        assert!(
            (tracker.bpm() - 120.0).abs() <= 3.0,
            "Expected BPM 120 +/- 3, got {}",
            tracker.bpm()
        );
        assert!(
            tracker.confidence() > 0.6,
            "Expected confidence > 0.6, got {}",
            tracker.confidence()
        );
    }

    #[test]
    fn test_pll_phase_wraps_smoothly() {
        let mut tracker = BeatTracker::new();
        let dt = 0.01;
        let two_pi = std::f32::consts::TAU;
        let mut beat_count: i32 = 0;
        let mut prev_phase = tracker.phase();

        for _ in 0..300 {
            tracker.push_onset(0.0, false, dt);
            let ph = tracker.phase();
            assert!(
                ph >= 0.0 && ph < two_pi,
                "Phase must stay in [0, 2pi), got {ph}"
            );
            if tracker.is_predictive_beat() {
                beat_count += 1;
                // Wrapping across 0 means new phase is smaller than previous phase
                assert!(
                    ph < prev_phase,
                    "Phase should wrap across 0: ph={ph}, prev={prev_phase}"
                );
            }
            prev_phase = ph;
        }

        // At default 120 BPM (0.5s period), 3.0s = 6 beats
        assert!(
            (beat_count - 6).abs() <= 1,
            "Expected ~6 beats in 3 seconds, got {beat_count}"
        );
    }

    #[test]
    fn test_silence_produces_zero_confidence_safe_defaults() {
        let mut tracker = BeatTracker::new();
        let dt = 0.01;
        for _ in 0..200 {
            tracker.push_onset(0.0, false, dt);
        }

        assert_eq!(tracker.confidence(), 0.0);
        assert_eq!(tracker.bpm(), DEFAULT_BPM);
        assert!(tracker.phase() >= 0.0 && tracker.phase() < std::f32::consts::TAU);
    }
}
