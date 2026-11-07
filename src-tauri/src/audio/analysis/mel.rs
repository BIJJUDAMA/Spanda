pub const DB_FLOOR: f32 = -80.0;

/// Converts frequency in Hertz to Mel scale.
pub fn hz_to_mel(f: f32) -> f32 {
    if f <= 0.0 {
        return 0.0;
    }
    2595.0 * (1.0 + f / 700.0).log10()
}

/// Converts Mel scale to frequency in Hertz.
pub fn mel_to_hz(m: f32) -> f32 {
    if m <= 0.0 {
        return 0.0;
    }
    700.0 * (10.0f32.powf(m / 2595.0) - 1.0)
}

/// Computes the A-weighting frequency response gain factor according to IEC 61672-1:2013.
///
/// Gain is normalized to 1.0 (0 dB) at 1000 Hz, and clamped to `[0.01, 2.0]` to suppress
/// infrasound/sub-audible rumble while allowing realistic human ear sensitivity shaping.
pub fn a_weighting_gain(f: f32) -> f32 {
    if f <= 0.0 {
        return 0.01;
    }
    let f = f as f64;
    let f2 = f * f;
    let f4 = f2 * f2;
    let num = (12194.0 * 12194.0) * f4;
    let den = (f2 + 20.6 * 20.6)
        * ((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9)).sqrt()
        * (f2 + 12194.0 * 12194.0);

    if den <= 0.0 || num <= 0.0 {
        return 0.01;
    }

    let ra = num / den;
    let a_db = 2.0 + 20.0 * ra.log10();
    let gain = 10.0f64.powf(a_db / 20.0);
    (gain as f32).clamp(0.01, 2.0)
}

/// Maps linear magnitude to normalized dB in `[0.0, 1.0]` over a range of -80 dB to 0 dB.
pub fn mag_to_normalized_db(mag: f32) -> f32 {
    if !mag.is_finite() || mag <= 1e-5 {
        return 0.0;
    }
    let db = 20.0 * mag.log10();
    ((db - DB_FLOOR) / (-DB_FLOOR)).clamp(0.0, 1.0)
}

#[derive(Clone, Debug)]
pub struct MelBandFilter {
    pub start_bin: usize,
    pub weights: Vec<f32>,
}

#[derive(Clone, Debug)]
pub struct MelBank {
    sample_rate: u32,
    window_size: usize,
    num_bands: usize,
    min_freq: f32,
    max_freq: f32,
    center_freqs: Vec<f32>,
    a_weights: Vec<f32>,
    filters: Vec<MelBandFilter>,
}

impl MelBank {
    /// Creates a new `MelBank` precomputing triangular filters and A-weighting weights.
    pub fn new(
        sample_rate: u32,
        window_size: usize,
        num_bands: usize,
        min_freq: f32,
        max_freq: f32,
    ) -> Self {
        let num_bins = window_size / 2 + 1;
        let bin_hz = sample_rate as f32 / window_size as f32;
        let nyquist = sample_rate as f32 / 2.0;
        let eff_max_freq = max_freq.min(nyquist).max(min_freq + 1.0);
        let eff_min_freq = min_freq.max(0.0);

        let a_weights: Vec<f32> = (0..num_bins)
            .map(|k| a_weighting_gain(k as f32 * bin_hz))
            .collect();

        let min_mel = hz_to_mel(eff_min_freq);
        let max_mel = hz_to_mel(eff_max_freq);

        let total_points = num_bands + 2;
        let mel_step = (max_mel - min_mel) / (total_points - 1) as f32;
        let points_hz: Vec<f32> = (0..total_points)
            .map(|i| mel_to_hz(min_mel + (i as f32) * mel_step))
            .collect();

        let center_freqs: Vec<f32> = points_hz[1..=num_bands].to_vec();

        let mut filters = Vec::with_capacity(num_bands);

        for b in 0..num_bands {
            let f_left = points_hz[b];
            let f_center = points_hz[b + 1];
            let f_right = points_hz[b + 2];

            let mut start_bin = None;
            let mut end_bin = 0;
            let mut raw_weights = vec![0.0f32; num_bins];

            for (k, slot) in raw_weights.iter_mut().enumerate().take(num_bins) {
                let f = k as f32 * bin_hz;
                let w = if f >= f_left && f <= f_center {
                    if f_center > f_left {
                        (f - f_left) / (f_center - f_left)
                    } else {
                        1.0
                    }
                } else if f > f_center && f <= f_right {
                    if f_right > f_center {
                        (f_right - f) / (f_right - f_center)
                    } else {
                        0.0
                    }
                } else {
                    0.0
                };

                if w > 0.0 {
                    if start_bin.is_none() {
                        start_bin = Some(k);
                    }
                    end_bin = k;
                    *slot = w;
                }
            }

            let filter = if let Some(start) = start_bin {
                let weights = raw_weights[start..=end_bin].to_vec();
                MelBandFilter {
                    start_bin: start,
                    weights,
                }
            } else {
                MelBandFilter {
                    start_bin: 0,
                    weights: Vec::new(),
                }
            };

            filters.push(filter);
        }

        Self {
            sample_rate,
            window_size,
            num_bands,
            min_freq: eff_min_freq,
            max_freq: eff_max_freq,
            center_freqs,
            a_weights,
            filters,
        }
    }

    /// Computes normalized dB Mel values across `num_bands` applying A-weighting gain.
    pub fn compute(&self, magnitudes: &[f32]) -> Vec<f32> {
        let mut mel = vec![0.0f32; self.num_bands];
        for (b, filter) in self.filters.iter().enumerate() {
            let mut sum = 0.0f32;
            for (i, &w) in filter.weights.iter().enumerate() {
                let bin = filter.start_bin + i;
                if bin < magnitudes.len() && bin < self.a_weights.len() {
                    let m = if magnitudes[bin].is_finite() {
                        magnitudes[bin]
                    } else {
                        0.0
                    };
                    sum += m * self.a_weights[bin] * w;
                }
            }
            mel[b] = mag_to_normalized_db(sum);
        }
        mel
    }

    /// Computes raw A-weighted linear magnitudes for each Mel band filter.
    pub fn compute_magnitudes(&self, magnitudes: &[f32]) -> Vec<f32> {
        let mut mel = vec![0.0f32; self.num_bands];
        for (b, filter) in self.filters.iter().enumerate() {
            let mut sum = 0.0f32;
            for (i, &w) in filter.weights.iter().enumerate() {
                let bin = filter.start_bin + i;
                if bin < magnitudes.len() && bin < self.a_weights.len() {
                    let m = if magnitudes[bin].is_finite() {
                        magnitudes[bin]
                    } else {
                        0.0
                    };
                    sum += m * self.a_weights[bin] * w;
                }
            }
            mel[b] = sum;
        }
        mel
    }

    /// Computes raw A-weighted dB values for each Mel band filter.
    pub fn compute_dbs(&self, magnitudes: &[f32]) -> Vec<f32> {
        let mags = self.compute_magnitudes(magnitudes);
        mags.iter().map(|&m| super::agc::mag_to_db(m)).collect()
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn window_size(&self) -> usize {
        self.window_size
    }

    pub fn num_bands(&self) -> usize {
        self.num_bands
    }

    pub fn min_freq(&self) -> f32 {
        self.min_freq
    }

    pub fn max_freq(&self) -> f32 {
        self.max_freq
    }

    pub fn center_frequencies(&self) -> &[f32] {
        &self.center_freqs
    }

    pub fn a_weights(&self) -> &[f32] {
        &self.a_weights
    }

    pub fn filter_weight(&self, band: usize, bin: usize) -> f32 {
        if band >= self.filters.len() {
            return 0.0;
        }
        let filter = &self.filters[band];
        if bin < filter.start_bin || bin >= filter.start_bin + filter.weights.len() {
            0.0
        } else {
            filter.weights[bin - filter.start_bin]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hz_to_mel_and_mel_to_hz_roundtrip() {
        assert_eq!(hz_to_mel(0.0), 0.0);
        assert_eq!(mel_to_hz(0.0), 0.0);

        let mel_1k = hz_to_mel(1000.0);
        assert!(
            (mel_1k - 1000.0).abs() < 1.0,
            "1000 Hz should be ~1000 Mel, got {mel_1k}"
        );

        let test_freqs = [20.0, 60.0, 150.0, 440.0, 1000.0, 3500.0, 8000.0, 20000.0];
        for &f in &test_freqs {
            let m = hz_to_mel(f);
            let roundtrip = mel_to_hz(m);
            assert!(
                (roundtrip - f).abs() < 0.01,
                "Roundtrip failed for {f} Hz: got {roundtrip}"
            );
        }
    }

    #[test]
    fn test_a_weighting_profile() {
        // At 1000 Hz, gain should be ~1.0 (0 dB reference)
        let gain_1k = a_weighting_gain(1000.0);
        assert!(
            (gain_1k - 1.0).abs() < 0.01,
            "1 kHz gain should be ~1.0, got {gain_1k}"
        );

        // Sub-bass 20 Hz should be heavily attenuated
        let gain_20 = a_weighting_gain(20.0);
        assert!(
            gain_20 <= 0.02,
            "20 Hz should be strongly suppressed, got {gain_20}"
        );

        // Human ear resonance around 2.5 kHz - 3.5 kHz has a slight boost (> 1.0)
        let gain_3k = a_weighting_gain(3000.0);
        assert!(
            gain_3k > 1.0 && gain_3k <= 2.0,
            "3 kHz should have ear sensitivity boost > 1.0, got {gain_3k}"
        );

        // Upper treble 20 kHz is attenuated relative to mid-band
        let gain_20k = a_weighting_gain(20000.0);
        assert!(
            gain_20k < 0.8,
            "20 kHz should be attenuated relative to 1 kHz, got {gain_20k}"
        );

        // Zero / negative frequency should return the lower clamp
        assert_eq!(a_weighting_gain(0.0), 0.01);
        assert_eq!(a_weighting_gain(-50.0), 0.01);
    }

    #[test]
    fn test_triangular_filterbank_sum() {
        let sample_rate = 48000;
        let window_size = 4096;
        let num_bands = 64;
        let mel = MelBank::new(sample_rate, window_size, num_bands, 20.0, 20000.0);

        let bin_hz = sample_rate as f32 / window_size as f32;
        let centers = mel.center_frequencies();
        let f_first_center = centers[0];
        let f_last_center = centers[num_bands - 1];

        // For all FFT bins strictly between the first and last filter center frequencies,
        // adjacent triangular overlapping filters must sum to exactly 1.0 (partition of unity).
        let mut tested_bins = 0;
        let num_bins = window_size / 2 + 1;
        for k in 0..num_bins {
            let f = k as f32 * bin_hz;
            if f >= f_first_center && f <= f_last_center {
                let weight_sum: f32 = (0..num_bands).map(|b| mel.filter_weight(b, k)).sum();
                assert!(
                    (weight_sum - 1.0).abs() < 1e-4,
                    "Bin {k} ({f} Hz) filterbank sum should be 1.0, got {weight_sum}"
                );
                tested_bins += 1;
            }
        }

        assert!(
            tested_bins > 1000,
            "Should have verified filterbank unity sum across >1000 bins, verified {tested_bins}"
        );
    }

    #[test]
    fn test_mel_filterbank_64_bands_and_a_weighting() {
        let mel = MelBank::new(48000, 4096, 64, 20.0, 20000.0);
        let mags = vec![1.0f32; 2049];
        let weighted = mel.compute(&mags);
        assert_eq!(weighted.len(), 64);
        // High-frequency treble and 1kHz should be boosted relative to inaudible 20Hz
        assert!(
            weighted[32] > weighted[0],
            "Band 32 ({}) should exceed Band 0 ({}) due to A-weighting",
            weighted[32],
            weighted[0]
        );
    }

    #[test]
    fn test_silence_gives_zero_mel_bands() {
        let mel = MelBank::new(48000, 4096, 64, 20.0, 20000.0);
        let silence = vec![0.0f32; 2049];
        let weighted = mel.compute(&silence);
        assert_eq!(weighted.len(), 64);
        assert!(
            weighted.iter().all(|&v| v == 0.0),
            "Silence should yield all 0.0 mel bands"
        );
    }
}
