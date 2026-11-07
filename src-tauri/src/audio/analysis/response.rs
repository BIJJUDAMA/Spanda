/// Kick-Band (70–160 Hz) spectral flux onset detector.
///
/// Features:
/// - Tracks kick band energy $K_t$ from frame to frame.
/// - Half-wave rectified flux: $\text{Flux}_t = \max(0.0, K_t - K_{t-1})$.
/// - Adaptive threshold: $\text{Threshold} = \max(0.08, \mu + k \cdot \sigma)$.
/// - Running statistics ($\mu, \sigma^2$) updated via exponential moving average over ~1.0s window:
///   - $\mu \leftarrow \mu + \alpha (\text{Flux} - \mu)$
///   - $\sigma^2 \leftarrow \sigma^2 + \alpha ((\text{Flux} - \mu)^2 - \sigma^2)$
/// - 110ms refractory gate preventing double triggers within 110ms.
/// - Returns `(is_onset: bool, flux_strength: f32)`.
/// - When `is_onset` is true, flux strength is normalized into [0.0, 1.0].
#[derive(Debug, Clone)]
pub struct KickOnsetDetector {
    prev_kick: f32,
    mean_flux: f32,
    var_flux: f32,
    last_onset_time_ms: f64,
    refractory_period_ms: f64,
    k_threshold: f32,
    min_threshold: f32,
    alpha: f32,
}

impl KickOnsetDetector {
    pub const DEFAULT_REFRACTORY_MS: f64 = 110.0;
    pub const DEFAULT_K_THRESHOLD: f32 = 1.6;
    pub const DEFAULT_MIN_THRESHOLD: f32 = 0.08;
    pub const DEFAULT_ALPHA: f32 = 0.02;

    pub fn new(refractory_period_ms: f64, k_threshold: f32) -> Self {
        Self {
            prev_kick: 0.0,
            mean_flux: 0.0,
            var_flux: 0.0,
            last_onset_time_ms: -1000.0,
            refractory_period_ms,
            k_threshold,
            min_threshold: Self::DEFAULT_MIN_THRESHOLD,
            alpha: Self::DEFAULT_ALPHA,
        }
    }

    pub fn with_alpha(mut self, alpha: f32) -> Self {
        self.alpha = alpha;
        self
    }

    pub fn with_min_threshold(mut self, min_threshold: f32) -> Self {
        self.min_threshold = min_threshold;
        self
    }

    pub fn reset(&mut self) {
        self.prev_kick = 0.0;
        self.mean_flux = 0.0;
        self.var_flux = 0.0;
        self.last_onset_time_ms = -1000.0;
    }

    pub fn prev_kick(&self) -> f32 {
        self.prev_kick
    }

    pub fn mean_flux(&self) -> f32 {
        self.mean_flux
    }

    pub fn threshold(&self) -> f32 {
        self.min_threshold
            .max(self.mean_flux + self.k_threshold * self.var_flux.max(0.0).sqrt())
    }

    pub fn process(&mut self, kick: f32, now_ms: f64) -> (bool, f32) {
        let kick = if kick.is_finite() { kick.max(0.0) } else { 0.0 };
        let flux = (kick - self.prev_kick).max(0.0);
        self.prev_kick = kick;

        if kick <= 1e-4 {
            self.prev_kick = 0.0;
        }

        let threshold = self.threshold();

        // Update running mean and variance (EMA)
        let diff = flux - self.mean_flux;
        self.mean_flux += self.alpha * diff;
        let var_diff = (flux - self.mean_flux).powi(2) - self.var_flux;
        self.var_flux = (self.var_flux + self.alpha * var_diff).max(0.0);

        let is_refractory = (now_ms - self.last_onset_time_ms) < self.refractory_period_ms;

        if flux > threshold && !is_refractory {
            self.last_onset_time_ms = now_ms;
            (true, flux.clamp(0.0, 1.0))
        } else {
            (false, 0.0)
        }
    }
}

impl Default for KickOnsetDetector {
    fn default() -> Self {
        Self::new(Self::DEFAULT_REFRACTORY_MS, Self::DEFAULT_K_THRESHOLD)
    }
}

/// Transient and rhythm onset detector based on bass energy flux vs moving baseline.
/// Features:
/// - 120 ms refractory interval between detected onsets
/// - Moving baseline tracks sustained signal
/// - Output in [0.0, 1.0]
/// - Silence clears the baseline
#[derive(Debug, Clone)]
pub struct TransientDetector {
    baseline: f32,
    last_onset_time_ms: f64,
    refractory_period_ms: f64,
}

impl TransientDetector {
    pub const REFRACTORY_PERIOD_MS: f64 = 120.0;

    pub fn new() -> Self {
        Self {
            baseline: 0.0,
            last_onset_time_ms: -1000.0,
            refractory_period_ms: Self::REFRACTORY_PERIOD_MS,
        }
    }

    pub fn reset(&mut self) {
        self.baseline = 0.0;
        self.last_onset_time_ms = -1000.0;
    }

    pub fn process(&mut self, bass_energy: f32, now_ms: f64) -> f32 {
        if bass_energy <= 1e-4 {
            // Silence clears baseline
            self.baseline = 0.0;
            return 0.0;
        }

        let delta = bass_energy - self.baseline;
        let is_refractory = (now_ms - self.last_onset_time_ms) < self.refractory_period_ms;

        if delta > 0.05 && !is_refractory {
            self.last_onset_time_ms = now_ms;
            // Update baseline towards new energy
            self.baseline = self.baseline * 0.5 + bass_energy * 0.5;
            // Map positive flux to [0, 1]
            (delta / 0.25).clamp(0.0, 1.0)
        } else {
            // Adapt baseline towards sustained energy
            if bass_energy > self.baseline {
                self.baseline += 0.2 * (bass_energy - self.baseline);
            } else {
                self.baseline += 0.08 * (bass_energy - self.baseline);
            }
            0.0
        }
    }
}

impl Default for TransientDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulse_triggers_one_onset_and_silence_clears_baseline() {
        let mut detector = TransientDetector::new();

        // Silence gives 0
        assert_eq!(detector.process(0.0, 0.0), 0.0);

        // Sudden pulse of bass energy
        let onset1 = detector.process(0.8, 10.0);
        assert!(onset1 > 0.0, "Expected positive onset for pulse");

        // Immediately subsequent frame within refractory period (e.g. 50ms < 120ms)
        let onset2 = detector.process(0.85, 50.0);
        assert_eq!(
            onset2, 0.0,
            "Refractory period must prevent immediate re-trigger"
        );

        // Sustained high signal over time
        for t in [150.0, 200.0, 250.0, 300.0, 400.0] {
            let _ = detector.process(0.85, t);
        }
        // Baseline has now caught up to 0.85, so subsequent frame does not trigger
        let sustained_onset = detector.process(0.85, 500.0);
        assert_eq!(
            sustained_onset, 0.0,
            "Sustained signal must not repeatedly trigger"
        );

        // Return to silence
        assert_eq!(detector.process(0.0, 600.0), 0.0);
        assert_eq!(detector.baseline, 0.0, "Silence must clear baseline");

        // After silence, another pulse triggers a new onset
        let onset_after_silence = detector.process(0.8, 800.0);
        assert!(
            onset_after_silence > 0.0,
            "New pulse after silence must trigger onset"
        );
    }

    #[test]
    fn sharp_kick_transients_trigger_onset_with_positive_flux() {
        let mut detector = KickOnsetDetector::new(110.0, 1.6);

        // Baseline at t=0
        let (is_onset, flux) = detector.process(0.0, 0.0);
        assert!(!is_onset);
        assert_eq!(flux, 0.0);

        // Sharp kick transient jump from 0.0 to 0.85
        let (is_onset, flux) = detector.process(0.85, 120.0);
        assert!(is_onset, "Sharp kick transient must trigger onset");
        assert!(
            flux > 0.0 && flux <= 1.0,
            "Flux strength must be normalized in (0.0, 1.0], got {}",
            flux
        );
    }

    #[test]
    fn continuous_low_drone_produces_zero_flux_and_does_not_trigger_onset() {
        let mut detector = KickOnsetDetector::new(110.0, 1.6);
        // Feed initial frame to establish drone level
        detector.process(0.8, 0.0);

        // Constant drone (0.8) across subsequent frames produces zero flux
        for t in [20.0, 40.0, 60.0, 100.0, 200.0, 500.0] {
            let (is_onset, flux) = detector.process(0.8, t);
            assert!(
                !is_onset,
                "Continuous drone (constant 0.8) must not trigger onset at t={}",
                t
            );
            assert_eq!(flux, 0.0, "Continuous drone produces 0 flux at t={}", t);
        }
    }

    #[test]
    fn second_hit_within_60ms_is_suppressed_by_110ms_refractory_window() {
        let mut detector = KickOnsetDetector::new(110.0, 1.6);
        // First sharp kick hit at t=100.0ms
        let (is_onset1, flux1) = detector.process(0.9, 100.0);
        assert!(is_onset1, "First kick hit must trigger onset");
        assert!(flux1 > 0.0);

        // Signal drops
        detector.process(0.1, 120.0);

        // Second sharp kick hit at t=160.0ms (60ms after first hit)
        let (is_onset2, flux2) = detector.process(0.95, 160.0);
        assert!(
            !is_onset2,
            "Second hit within 60ms must be suppressed by the 110ms refractory window"
        );
        assert_eq!(flux2, 0.0, "Suppressed hit should have 0 flux strength");

        // Signal drops
        detector.process(0.1, 180.0);

        // Third hit at t=230.0ms (130ms after first hit, > 110ms)
        let (is_onset3, flux3) = detector.process(0.95, 230.0);
        assert!(
            is_onset3,
            "Hit after 110ms refractory period (130ms elapsed) must trigger onset"
        );
        assert!(flux3 > 0.0);
    }

    #[test]
    fn reset_clears_state_cleanly() {
        let mut detector = KickOnsetDetector::new(110.0, 1.6);
        let (is_onset, _) = detector.process(0.9, 100.0);
        assert!(is_onset);

        // Without reset, hit at 140ms (40ms later) is blocked by refractory
        detector.process(0.1, 120.0);
        let (blocked, _) = detector.process(0.9, 140.0);
        assert!(!blocked);

        // Reset clears state
        detector.reset();
        assert_eq!(detector.prev_kick(), 0.0);
        assert_eq!(detector.mean_flux(), 0.0);

        // Now a hit at 150ms triggers immediately because state was cleared
        let (is_onset_after_reset, flux) = detector.process(0.9, 150.0);
        assert!(
            is_onset_after_reset,
            "After reset, sharp transient must trigger onset regardless of previous timestamps"
        );
        assert!(flux > 0.0);
    }
}
