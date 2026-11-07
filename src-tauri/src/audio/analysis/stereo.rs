//! Stereo and Mid/Side (M/S) soundstage analysis metrics.

/// Stereo field metrics including peak levels per channel, inter-channel correlation, and stereo width.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StereoMetrics {
    pub left_peak: f32,
    pub right_peak: f32,
    pub correlation: f32,
    pub width: f32,
    pub stereo_width: f32,
}

impl Default for StereoMetrics {
    fn default() -> Self {
        Self {
            left_peak: 0.0,
            right_peak: 0.0,
            correlation: 1.0,
            width: 0.0,
            stereo_width: 0.0,
        }
    }
}

/// Computes stereo metrics from interleaved PCM samples.
///
/// If `channels <= 1`, returns identical left/right peak and stereo width of 0.0.
/// If `channels >= 2`, channels 0 and 1 are treated as Left and Right.
pub fn compute_stereo_metrics(samples: &[f32], channels: usize) -> StereoMetrics {
    if channels <= 1 {
        let mut peak = 0.0f32;
        for &s in samples {
            let mag = s.abs();
            if mag.is_finite() && mag > peak {
                peak = mag;
            }
        }
        return StereoMetrics {
            left_peak: peak,
            right_peak: peak,
            correlation: 1.0,
            width: 0.0,
            stereo_width: 0.0,
        };
    }

    let frames = samples.len() / channels;
    if frames == 0 {
        return StereoMetrics::default();
    }

    let mut left_peak = 0.0f32;
    let mut right_peak = 0.0f32;
    let mut sum_l_r = 0.0f32;
    let mut sum_l_sq = 0.0f32;
    let mut sum_r_sq = 0.0f32;
    let mut sum_mid_sq = 0.0f32;
    let mut sum_side_sq = 0.0f32;

    for f in 0..frames {
        let raw_l = samples[f * channels];
        let raw_r = samples[f * channels + 1];

        let l = if raw_l.is_finite() { raw_l } else { 0.0 };
        let r = if raw_r.is_finite() { raw_r } else { 0.0 };

        let abs_l = l.abs();
        let abs_r = r.abs();
        if abs_l > left_peak {
            left_peak = abs_l;
        }
        if abs_r > right_peak {
            right_peak = abs_r;
        }

        sum_l_r += l * r;
        sum_l_sq += l * l;
        sum_r_sq += r * r;

        let mid = l + r;
        let side = l - r;
        sum_mid_sq += mid * mid;
        sum_side_sq += side * side;
    }

    const EPSILON: f32 = 1e-12;
    let denom = (sum_l_sq * sum_r_sq + EPSILON).sqrt();
    let correlation = (sum_l_r / denom).clamp(-1.0, 1.0);

    // M/S side energy ratio:
    // Mid energy = sum((L + R)^2)
    // Side energy = sum((L - R)^2)
    // Total energy = Mid energy + Side energy = 2 * (sum(L^2) + sum(R^2))
    // When L == R (mono): Side energy = 0 -> width = 0.0
    // When L == -R (antiphase): Mid energy = 0 -> width = 1.0
    let total_energy = sum_mid_sq + sum_side_sq;
    let width = if total_energy > 1e-9 {
        (sum_side_sq / total_energy).clamp(0.0, 1.0)
    } else {
        0.0
    };

    StereoMetrics {
        left_peak,
        right_peak,
        correlation,
        width,
        stereo_width: width,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mono_samples_yield_width_zero() {
        let mono_samples = vec![0.2, -0.4, 0.8, -0.6];
        let metrics = compute_stereo_metrics(&mono_samples, 1);

        assert_eq!(metrics.width, 0.0);
        assert_eq!(metrics.stereo_width, 0.0);
        assert!((metrics.left_peak - 0.8).abs() < 1e-6);
        assert!((metrics.right_peak - 0.8).abs() < 1e-6);
    }

    #[test]
    fn test_identical_stereo_channels_yield_width_zero() {
        // L == R
        let stereo_samples = vec![0.5, 0.5, -0.7, -0.7, 0.3, 0.3];
        let metrics = compute_stereo_metrics(&stereo_samples, 2);

        assert_eq!(metrics.width, 0.0);
        assert_eq!(metrics.stereo_width, 0.0);
        assert!((metrics.correlation - 1.0).abs() < 1e-4);
        assert!((metrics.left_peak - 0.7).abs() < 1e-6);
        assert!((metrics.right_peak - 0.7).abs() < 1e-6);
    }

    #[test]
    fn test_antiphase_stereo_yields_width_greater_than_0_95() {
        // L == -R
        let stereo_samples = vec![0.5, -0.5, -0.7, 0.7, 0.3, -0.3];
        let metrics = compute_stereo_metrics(&stereo_samples, 2);

        assert!(
            metrics.width > 0.95,
            "Expected antiphase width > 0.95, got {}",
            metrics.width
        );
        assert!(
            metrics.stereo_width > 0.95,
            "Expected antiphase stereo_width > 0.95, got {}",
            metrics.stereo_width
        );
        assert!(
            (metrics.correlation - (-1.0)).abs() < 1e-4,
            "Expected correlation -1.0, got {}",
            metrics.correlation
        );
    }

    #[test]
    fn test_silence_yields_safe_zero_metrics() {
        let silence = vec![0.0f32; 16];
        let metrics = compute_stereo_metrics(&silence, 2);

        assert!(!metrics.width.is_nan());
        assert!(!metrics.correlation.is_nan());
        assert_eq!(metrics.left_peak, 0.0);
        assert_eq!(metrics.right_peak, 0.0);
        assert_eq!(metrics.width, 0.0);
    }
}
