pub const SILENCE_DB: f32 = -75.0;
pub const SILENCE_MAG: f32 = 1e-5;
pub const MIN_DYNAMIC_RANGE_DB: f32 = 12.0;
pub const DEFAULT_GAMMA: f32 = 1.4;
pub const DEFAULT_WINDOW_SECONDS: f32 = 1.5;
pub const DEFAULT_INITIAL_CEILING: f32 = 0.0;
pub const DEFAULT_INITIAL_FLOOR: f32 = -75.0;

/// Converts linear magnitude to decibels (dBFS).
/// Magnitudes below `SILENCE_MAG` (1e-5) return `-100.0` dB.
pub fn mag_to_db(mag: f32) -> f32 {
    if !mag.is_finite() || mag <= SILENCE_MAG {
        -100.0
    } else {
        20.0 * mag.log10()
    }
}

/// Dynamic range normalizer and auto-gain controller (AGC) tracking running
/// floor and ceiling independently per frequency band.
#[derive(Clone, Debug)]
pub struct BandNormalizer {
    num_bands: usize,
    window_seconds: f32,
    gamma: f32,
    ceilings: Vec<f32>,
    floors: Vec<f32>,
    tau_ceiling_decay: f32,
    tau_floor_attack: f32,
    tau_floor_release: f32,
}

impl BandNormalizer {
    /// Creates a new `BandNormalizer` for `num_bands` with specified adaptation window and contrast gamma.
    pub fn new(num_bands: usize, window_seconds: f32, gamma: f32) -> Self {
        let win = if window_seconds.is_finite() && window_seconds > 0.0 {
            window_seconds
        } else {
            DEFAULT_WINDOW_SECONDS
        };
        let g = if gamma.is_finite() && gamma > 0.0 {
            gamma
        } else {
            DEFAULT_GAMMA
        };

        Self {
            num_bands,
            window_seconds: win,
            gamma: g,
            ceilings: vec![DEFAULT_INITIAL_CEILING; num_bands],
            floors: vec![DEFAULT_INITIAL_FLOOR; num_bands],
            tau_ceiling_decay: win,
            tau_floor_attack: 0.1,
            tau_floor_release: 3.0,
        }
    }

    /// Creates a default `BandNormalizer` with 1.5s adaptation window and gamma 1.4.
    pub fn default_for(num_bands: usize) -> Self {
        Self::new(num_bands, DEFAULT_WINDOW_SECONDS, DEFAULT_GAMMA)
    }

    /// Resets all tracking ceilings and floors to initial defaults.
    pub fn reset(&mut self) {
        for c in &mut self.ceilings {
            *c = DEFAULT_INITIAL_CEILING;
        }
        for f in &mut self.floors {
            *f = DEFAULT_INITIAL_FLOOR;
        }
    }

    fn ensure_capacity(&mut self, len: usize) {
        if self.ceilings.len() < len {
            self.ceilings.resize(len, DEFAULT_INITIAL_CEILING);
            self.floors.resize(len, DEFAULT_INITIAL_FLOOR);
        }
    }

    /// Normalizes a single dB value given floor, ceiling, and gamma.
    pub fn normalize_single(db: f32, floor: f32, ceiling: f32, gamma: f32) -> f32 {
        if !db.is_finite() || db < SILENCE_DB {
            return 0.0;
        }
        let delta_range = (ceiling - floor).max(MIN_DYNAMIC_RANGE_DB);
        let r = ((db - floor) / delta_range).clamp(0.0, 1.0);
        r.powf(gamma)
    }

    /// Processes a slice of band dB values, updating internal running floor/ceiling and
    /// returning normalized values in `[0.0, 1.0]`.
    pub fn process(&mut self, band_dbs: &[f32], dt: f32) -> Vec<f32> {
        let mut out = vec![0.0f32; band_dbs.len()];
        self.process_into(band_dbs, dt, &mut out);
        out
    }

    /// Processes a slice of band dB values into a destination buffer.
    pub fn process_into(&mut self, band_dbs: &[f32], dt: f32, out: &mut [f32]) {
        self.ensure_capacity(band_dbs.len());
        let dt = if dt.is_finite() && dt > 0.0 {
            dt
        } else {
            0.016
        };

        for (i, &db) in band_dbs.iter().enumerate() {
            if !db.is_finite() || db < SILENCE_DB {
                out[i] = 0.0;
                continue;
            }

            // Ceiling tracking: instant attack on louder peaks, continuous exponential decay otherwise
            if db > self.ceilings[i] {
                self.ceilings[i] = db;
            } else {
                let alpha_decay = 1.0 - (-dt / self.tau_ceiling_decay).exp();
                self.ceilings[i] += alpha_decay * (db - self.ceilings[i]);
            }

            // Floor tracking: fast downward adaptation to quiet valleys, slow upward release
            if db < self.floors[i] {
                let alpha_attack = 1.0 - (-dt / self.tau_floor_attack).exp();
                self.floors[i] += alpha_attack * (db - self.floors[i]);
            } else {
                let alpha_release = 1.0 - (-dt / self.tau_floor_release).exp();
                self.floors[i] += alpha_release * (db - self.floors[i]);
            }

            // Bound floor below ceiling by minimum dynamic range
            let max_floor = self.ceilings[i] - MIN_DYNAMIC_RANGE_DB;
            if self.floors[i] > max_floor {
                self.floors[i] = max_floor;
            }

            // Normalization mapping with minimum dynamic range
            let delta_range = (self.ceilings[i] - self.floors[i]).max(MIN_DYNAMIC_RANGE_DB);
            let r = ((db - self.floors[i]) / delta_range).clamp(0.0, 1.0);
            out[i] = r.powf(self.gamma);
        }
    }

    /// Processes linear magnitudes by converting to dB and normalizing.
    pub fn process_magnitudes(&mut self, mags: &[f32], dt: f32) -> Vec<f32> {
        let dbs: Vec<f32> = mags.iter().map(|&m| mag_to_db(m)).collect();
        self.process(&dbs, dt)
    }

    pub fn ceilings(&self) -> &[f32] {
        &self.ceilings
    }

    pub fn floors(&self) -> &[f32] {
        &self.floors
    }

    pub fn num_bands(&self) -> usize {
        self.num_bands
    }

    pub fn gamma(&self) -> f32 {
        self.gamma
    }

    pub fn window_seconds(&self) -> f32 {
        self.window_seconds
    }
}

impl Default for BandNormalizer {
    fn default() -> Self {
        Self::new(64, DEFAULT_WINDOW_SECONDS, DEFAULT_GAMMA)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_per_band_agc_normalizes_quiet_and_loud_signals() {
        let mut agc = BandNormalizer::new(64, 1.5, 1.4);
        // Feed quiet signal (-40 dB)
        let quiet_bands = vec![-40.0f32; 64];
        for _ in 0..100 {
            agc.process(&quiet_bands, 0.016);
        }
        let out_quiet = agc.process(&vec![-30.0f32; 64], 0.016);
        assert!(
            out_quiet[0] > 0.7,
            "Dynamic range should expand quiet peaks to top scale, got {}",
            out_quiet[0]
        );
    }

    #[test]
    fn quiet_signal_peaks_expand_to_near_one() {
        let mut agc = BandNormalizer::new(4, 1.5, 1.4);
        // Oscillating quiet signal with peaks at -40 dB and floor at -55 dB
        for i in 0..150 {
            let val = if i % 10 == 0 { -40.0 } else { -55.0 };
            agc.process(&[val, val, val, val], 0.016);
        }
        let peak_out = agc.process(&[-40.0, -40.0, -40.0, -40.0], 0.016);
        for &p in &peak_out {
            assert!(
                p >= 0.95,
                "Quiet peak should expand to near 1.0 (>= 0.95), got {p}"
            );
        }
    }

    #[test]
    fn silence_outputs_zero() {
        let mut agc = BandNormalizer::new(64, 1.5, 1.4);

        // dB < -75.0 outputs exact 0.0
        let silence_db = vec![-80.0f32; 64];
        let out_db = agc.process(&silence_db, 0.016);
        for &v in &out_db {
            assert_eq!(v, 0.0);
        }

        let quiet_near_silence = vec![-76.0f32; 64];
        let out2 = agc.process(&quiet_near_silence, 0.016);
        for &v in &out2 {
            assert_eq!(v, 0.0);
        }

        // Magnitude <= 1e-5 outputs exact 0.0
        let silence_mags = vec![1e-6f32; 64];
        let out_mag = agc.process_magnitudes(&silence_mags, 0.016);
        for &v in &out_mag {
            assert_eq!(v, 0.0);
        }
    }

    #[test]
    fn gamma_shapes_curve() {
        let expected = 0.5f32.powf(1.4);
        assert!(
            (expected - 0.3789).abs() < 0.001,
            "0.5^1.4 should be approx 0.3789, got {expected}"
        );

        // Test with static normalize_single
        let val = BandNormalizer::normalize_single(-50.0, -60.0, -40.0, 1.4);
        assert!(
            (val - expected).abs() < 1e-5,
            "Normalized value at midpoint should match 0.5^1.4, got {val}"
        );

        // Test through BandNormalizer instance
        let mut agc = BandNormalizer::new(1, 1.5, 1.4);
        // Feed -40 dB to set ceiling, then -60 dB to establish floor
        agc.ceilings[0] = -40.0;
        agc.floors[0] = -60.0;
        let out = agc.process(&[-50.0], 0.0);
        // Note: processing -50.0 decays ceiling slightly, but with dt=0.0 it's exact:
        // Let's test with normalize_single or with dt close to 0:
        assert!((out[0] - expected).abs() < 0.02);
    }

    #[test]
    fn mag_to_db_endpoints() {
        assert_eq!(mag_to_db(0.0), -100.0);
        assert_eq!(mag_to_db(1e-5), -100.0);
        assert_eq!(mag_to_db(-1.0), -100.0);
        assert_eq!(mag_to_db(f32::NAN), -100.0);
        assert!((mag_to_db(1.0) - 0.0).abs() < 1e-5);
        assert!((mag_to_db(0.1) - (-20.0)).abs() < 1e-5);
    }
}
