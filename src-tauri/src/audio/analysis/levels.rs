/// RMS and absolute peak over all interleaved channels; input is normalized
/// AudioBlock samples. Channels are never mixed down before measuring energy.
pub fn levels(samples: &[f32]) -> (f32, f32) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum_squares = 0.0_f64;
    let mut peak = 0.0_f32;
    for &sample in samples {
        sum_squares += f64::from(sample) * f64::from(sample);
        peak = peak.max(sample.abs());
    }
    ((sum_squares / samples.len() as f64).sqrt() as f32, peak)
}

#[cfg(test)]
mod tests {
    use super::levels;

    #[test]
    fn antiphase_channels_keep_energy() {
        assert_eq!(levels(&[0.5, -0.5]), (0.5, 0.5));
    }

    #[test]
    fn silence_and_empty_input_have_zero_levels() {
        assert_eq!(levels(&[]), (0.0, 0.0));
        assert_eq!(levels(&[0.0; 8]), (0.0, 0.0));
    }

    #[test]
    fn rms_uses_every_sample_and_peak_is_absolute() {
        let (rms, peak) = levels(&[-1.0, 0.0, 0.0, 0.0]);
        assert_eq!(rms, 0.5);
        assert_eq!(peak, 1.0);
    }
}
