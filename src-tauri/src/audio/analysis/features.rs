//! Spectral features extraction: Chroma (12 pitch classes), Spectral Centroid, and Spectral Flatness.

pub const MAX_CHROMA_FREQ: f32 = 4186.0;

/// Extracts 12-dimensional chroma features representing pitch classes (C, C#, ..., B).
#[derive(Clone, Debug)]
pub struct ChromaExtractor {
    mappings: Vec<(usize, usize)>,
}

impl ChromaExtractor {
    /// Creates a new `ChromaExtractor` precomputing FFT bin to pitch class mappings up to 4186 Hz (C8).
    pub fn new(sample_rate: u32, window_size: usize) -> Self {
        if sample_rate == 0 || window_size == 0 {
            return Self {
                mappings: Vec::new(),
            };
        }

        let num_bins = window_size / 2 + 1;
        let bin_resolution = sample_rate as f32 / window_size as f32;
        let mut mappings = Vec::new();

        for k in 1..num_bins {
            let f = k as f32 * bin_resolution;
            if f > MAX_CHROMA_FREQ {
                break;
            }
            // 440 Hz is A4 (pitch class 9).
            // p = (round(12.0 * log2(f / 440.0)) + 9) mod 12
            // 0 = C, 1 = C#, 2 = D, 3 = D#, 4 = E, 5 = F, 6 = F#, 7 = G, 8 = G#, 9 = A, 10 = A#, 11 = B.
            let semitones = (12.0 * (f / 440.0).log2()).round() as i32;
            let pitch = (semitones + 9).rem_euclid(12) as usize;
            mappings.push((k, pitch));
        }

        Self { mappings }
    }

    /// Accumulates magnitude energy into 12 pitch classes and normalizes so max value is <= 1.0.
    pub fn extract(&self, magnitudes: &[f32]) -> [f32; 12] {
        let mut chroma = [0.0f32; 12];
        for &(k, pitch) in &self.mappings {
            if k < magnitudes.len() {
                chroma[pitch] += magnitudes[k];
            }
        }

        let max_val = chroma.iter().cloned().fold(0.0f32, f32::max);
        if max_val > 1e-6 {
            for val in &mut chroma {
                *val /= max_val;
            }
        }

        chroma
    }
}

/// Computes spectral centroid as the ratio of weighted frequency sum to total magnitude sum,
/// normalized by Nyquist to [0.0, 1.0].
pub fn compute_spectral_centroid(magnitudes: &[f32], sample_rate: u32, window_size: usize) -> f32 {
    if magnitudes.is_empty() || sample_rate == 0 || window_size == 0 {
        return 0.0;
    }

    let bin_resolution = sample_rate as f32 / window_size as f32;
    let nyquist = sample_rate as f32 / 2.0;
    if nyquist <= 0.0 {
        return 0.0;
    }

    let mut weighted_sum = 0.0f32;
    let mut total_magnitude = 0.0f32;

    for (k, &mag) in magnitudes.iter().enumerate() {
        if mag.is_finite() && mag > 0.0 {
            let freq = k as f32 * bin_resolution;
            weighted_sum += freq * mag;
            total_magnitude += mag;
        }
    }

    if total_magnitude <= 1e-6 {
        return 0.0;
    }

    let centroid_hz = weighted_sum / total_magnitude;
    (centroid_hz / nyquist).clamp(0.0, 1.0)
}

/// Computes spectral flatness (Wiener entropy) as the ratio of geometric mean to arithmetic mean
/// of magnitudes. Pure tones yield ~0.0, while flat broadband noise yields ~1.0.
pub fn compute_spectral_flatness(magnitudes: &[f32]) -> f32 {
    if magnitudes.is_empty() {
        return 0.0;
    }

    let n = magnitudes.len();
    let mut sum = 0.0f32;
    let mut log_sum = 0.0f32;
    const EPSILON: f32 = 1e-12;

    for &mag in magnitudes {
        let val = if mag.is_finite() && mag > 0.0 {
            mag
        } else {
            0.0
        };
        sum += val;
        let clamped = val.max(EPSILON);
        log_sum += clamped.ln();
    }

    let arithmetic_mean = sum / n as f32;
    if arithmetic_mean <= 1e-6 {
        return 0.0;
    }

    let geometric_mean = (log_sum / n as f32).exp();
    (geometric_mean / arithmetic_mean).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chroma_440hz_maps_to_pitch_class_9() {
        let sample_rate = 44100;
        let window_size = 4096;
        let extractor = ChromaExtractor::new(sample_rate, window_size);

        // Find the bin closest to 440 Hz
        let bin_res = sample_rate as f32 / window_size as f32;
        let bin_440 = (440.0 / bin_res).round() as usize;

        let num_bins = window_size / 2 + 1;
        let mut magnitudes = vec![0.0f32; num_bins];
        magnitudes[bin_440] = 1.0;

        let chroma = extractor.extract(&magnitudes);

        // Pitch class 9 is A (440 Hz)
        assert!(
            chroma[9] > 0.99,
            "Expected pitch class 9 (A) to be 1.0, got {}",
            chroma[9]
        );

        // Other pitch classes should be 0.0
        for (i, &val) in chroma.iter().enumerate() {
            if i != 9 {
                assert_eq!(val, 0.0, "Expected pitch class {} to be 0.0", i);
            }
        }
    }

    #[test]
    fn test_chroma_middle_c_maps_to_pitch_class_0() {
        let sample_rate = 44100;
        let window_size = 4096;
        let extractor = ChromaExtractor::new(sample_rate, window_size);

        // Middle C (C4) is ~261.63 Hz
        let bin_res = sample_rate as f32 / window_size as f32;
        let bin_c4 = (261.63 / bin_res).round() as usize;

        let num_bins = window_size / 2 + 1;
        let mut magnitudes = vec![0.0f32; num_bins];
        magnitudes[bin_c4] = 1.0;

        let chroma = extractor.extract(&magnitudes);

        assert!(
            chroma[0] > 0.99,
            "Expected pitch class 0 (C) to be 1.0, got {}",
            chroma[0]
        );
    }

    #[test]
    fn test_spectral_flatness_sine_vs_noise() {
        let num_bins = 1024;

        // 1. Single sine peak
        let mut sine_mags = vec![0.0f32; num_bins];
        sine_mags[100] = 1.0;
        let flatness_sine = compute_spectral_flatness(&sine_mags);
        assert!(
            flatness_sine < 0.05,
            "Expected sine wave flatness < 0.05, got {}",
            flatness_sine
        );

        // 2. Uniform broadband noise
        let noise_mags = vec![1.0f32; num_bins];
        let flatness_noise = compute_spectral_flatness(&noise_mags);
        assert!(
            (flatness_noise - 1.0).abs() < 1e-4,
            "Expected uniform noise flatness ~1.0, got {}",
            flatness_noise
        );

        // 3. Silence
        let silence_mags = vec![0.0f32; num_bins];
        let flatness_silence = compute_spectral_flatness(&silence_mags);
        assert_eq!(flatness_silence, 0.0);
    }

    #[test]
    fn test_spectral_centroid_calculation() {
        let sample_rate = 40000;
        let window_size = 4000;
        // bin_res = 10 Hz, nyquist = 20000 Hz
        let num_bins = window_size / 2 + 1;
        let mut mags = vec![0.0f32; num_bins];

        // Peak at 1000 Hz -> bin 100
        mags[100] = 1.0;
        let centroid = compute_spectral_centroid(&mags, sample_rate, window_size);
        let expected = 1000.0 / 20000.0;
        assert!(
            (centroid - expected).abs() < 1e-4,
            "Expected centroid {}, got {}",
            expected,
            centroid
        );

        // Silence gives 0.0
        let zero_mags = vec![0.0f32; num_bins];
        assert_eq!(
            compute_spectral_centroid(&zero_mags, sample_rate, window_size),
            0.0
        );
    }
}
