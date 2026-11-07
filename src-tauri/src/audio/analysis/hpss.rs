//! Harmonic-Percussive Separation (HPSS) using median filtering on spectrogram frames.
//!
//! Maintains a circular buffer of the last N_frames (default 15) spectrogram frames of N_bins (default 64).
//! Computes:
//! - Harmonic component H via horizontal median filter along time across the buffer.
//! - Percussive component P via vertical median filter along frequency across a 9-bin neighborhood.
//! - Soft Wiener masks:
//!   `M_H = H^2 / (H^2 + P^2 + epsilon)`
//!   `M_P = P^2 / (H^2 + P^2 + epsilon)`
//! - Normalized energies (h_energy, p_energy) in [0.0, 1.0].

pub const DEFAULT_NUM_FRAMES: usize = 15;
pub const DEFAULT_NUM_BINS: usize = 64;
pub const FREQ_NEIGHBORHOOD: usize = 9;
const EPSILON: f32 = 1e-7;

#[derive(Clone, Debug)]
pub struct HpssSeparator {
    n_frames: usize,
    n_bins: usize,
    buffer: Vec<f32>,
    write_pos: usize,
    frames_pushed: usize,
    h_mag: Vec<f32>,
    p_mag: Vec<f32>,
    time_scratch: Vec<f32>,
    freq_scratch: Vec<f32>,
    latest_energies: (f32, f32),
}

impl Default for HpssSeparator {
    fn default() -> Self {
        Self::new(DEFAULT_NUM_FRAMES, DEFAULT_NUM_BINS)
    }
}

impl HpssSeparator {
    pub fn new(n_frames: usize, n_bins: usize) -> Self {
        let n_frames = n_frames.max(1);
        let n_bins = n_bins.max(1);
        Self {
            n_frames,
            n_bins,
            buffer: vec![0.0; n_frames * n_bins],
            write_pos: 0,
            frames_pushed: 0,
            h_mag: vec![0.0; n_bins],
            p_mag: vec![0.0; n_bins],
            time_scratch: vec![0.0; n_frames],
            freq_scratch: vec![0.0; FREQ_NEIGHBORHOOD],
            latest_energies: (0.0, 0.0),
        }
    }

    pub fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.write_pos = 0;
        self.frames_pushed = 0;
        self.h_mag.fill(0.0);
        self.p_mag.fill(0.0);
        self.time_scratch.fill(0.0);
        self.freq_scratch.fill(0.0);
        self.latest_energies = (0.0, 0.0);
    }

    pub fn latest(&self) -> (f32, f32) {
        self.latest_energies
    }

    pub fn n_frames(&self) -> usize {
        self.n_frames
    }

    pub fn n_bins(&self) -> usize {
        self.n_bins
    }

    pub fn process(&mut self, frame: &[f32]) -> (f32, f32) {
        self.process_frame(frame)
    }

    pub fn process_frame(&mut self, frame: &[f32]) -> (f32, f32) {
        let mut total_energy = 0.0f32;
        let buf_offset = self.write_pos * self.n_bins;

        for k in 0..self.n_bins {
            let val = if k < frame.len() && frame[k].is_finite() && frame[k] > 0.0 {
                frame[k]
            } else {
                0.0
            };
            self.buffer[buf_offset + k] = val;
            total_energy += val;
        }

        self.write_pos = (self.write_pos + 1) % self.n_frames;
        self.frames_pushed += 1;

        if total_energy <= 1e-7 {
            self.latest_energies = (0.0, 0.0);
            return (0.0, 0.0);
        }

        // 1. Time-median filtering across the n_frames circular buffer -> Harmonic (H)
        let mid_time = self.n_frames / 2;
        for k in 0..self.n_bins {
            for t in 0..self.n_frames {
                self.time_scratch[t] = self.buffer[t * self.n_bins + k];
            }
            self.time_scratch
                .select_nth_unstable_by(mid_time, |a, b| a.total_cmp(b));
            self.h_mag[k] = self.time_scratch[mid_time];
        }

        // 2. Frequency-median filtering along neighborhood of 9 bins -> Percussive (P)
        let mid_freq = FREQ_NEIGHBORHOOD / 2;
        let radius = (FREQ_NEIGHBORHOOD / 2) as isize;
        for k in 0..self.n_bins {
            for (i, offset) in (-radius..=radius).enumerate() {
                let idx = k as isize + offset;
                self.freq_scratch[i] = if idx >= 0 && (idx as usize) < self.n_bins {
                    let u = idx as usize;
                    if u < frame.len() && frame[u].is_finite() && frame[u] > 0.0 {
                        frame[u]
                    } else {
                        0.0
                    }
                } else {
                    0.0
                };
            }
            self.freq_scratch
                .select_nth_unstable_by(mid_freq, |a, b| a.total_cmp(b));
            self.p_mag[k] = self.freq_scratch[mid_freq];
        }

        // 3. Soft Wiener masks and aggregate normalized energies
        let mut h_weighted_sum = 0.0f32;
        let mut p_weighted_sum = 0.0f32;

        for k in 0..self.n_bins {
            let s = if k < frame.len() && frame[k].is_finite() && frame[k] > 0.0 {
                frame[k]
            } else {
                0.0
            };
            let h2 = self.h_mag[k] * self.h_mag[k];
            let p2 = self.p_mag[k] * self.p_mag[k];
            let denom = h2 + p2 + EPSILON;
            let m_h = h2 / denom;
            let m_p = p2 / denom;

            h_weighted_sum += m_h * s;
            p_weighted_sum += m_p * s;
        }

        let h_energy = (h_weighted_sum / total_energy).clamp(0.0, 1.0);
        let p_energy = (p_weighted_sum / total_energy).clamp(0.0, 1.0);

        self.latest_energies = (h_energy, p_energy);
        self.latest_energies
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_silence_yields_zero_energies() {
        let mut hpss = HpssSeparator::new(15, 64);
        let silence = [0.0f32; 64];

        for _ in 0..20 {
            let (h, p) = hpss.process_frame(&silence);
            assert_eq!(h, 0.0);
            assert_eq!(p, 0.0);
            assert_eq!(hpss.latest(), (0.0, 0.0));
        }
    }

    #[test]
    fn test_sustained_sine_tone_yields_dominant_harmonic_energy() {
        let mut hpss = HpssSeparator::new(15, 64);
        let mut sine_frame = [0.0f32; 64];
        // Sustained narrowband peak at bin 20
        sine_frame[20] = 1.0;

        let mut final_h = 0.0f32;
        let mut final_p = 0.0f32;

        for _ in 0..15 {
            let (h, p) = hpss.process_frame(&sine_frame);
            final_h = h;
            final_p = p;
        }

        assert!(
            final_h > final_p * 1.8,
            "Expected sustained sine tone h_energy ({final_h}) > p_energy ({final_p}) * 1.8"
        );
        assert!(
            final_h > 0.8,
            "Expected high harmonic energy, got {final_h}"
        );
        assert!(
            final_p < 0.2,
            "Expected low percussive energy, got {final_p}"
        );
    }

    #[test]
    fn test_sudden_broadband_impulse_click_yields_dominant_percussive_energy() {
        let mut hpss = HpssSeparator::new(15, 64);
        // Broadband click across all 64 bins
        let click_frame = [1.0f32; 64];

        // An impulse arrives suddenly after silence
        let (h, p) = hpss.process_frame(&click_frame);

        assert!(
            p > h * 1.8,
            "Expected sudden broadband click p_energy ({p}) > h_energy ({h}) * 1.8"
        );
        assert!(p > 0.8, "Expected high percussive energy, got {p}");
        assert!(h < 0.2, "Expected low harmonic energy, got {h}");
    }

    #[test]
    fn test_hpss_separates_sine_tone_from_dirac_click() {
        let mut hpss = HpssSeparator::new(15, 64);
        let mut sustained_tone = [0.0f32; 64];
        sustained_tone[30] = 0.9;

        // Feed sustained tone over 15 frames
        let mut h_sine = 0.0;
        let mut p_sine = 0.0;
        for _ in 0..15 {
            let res = hpss.process_frame(&sustained_tone);
            h_sine = res.0;
            p_sine = res.1;
        }
        assert!(h_sine > p_sine * 2.0);

        // Reset and test broadband impulse click
        hpss.reset();
        let broadband_click = [0.9f32; 64];
        let (h_click, p_click) = hpss.process_frame(&broadband_click);
        assert!(p_click > h_click * 2.0);
    }

    #[test]
    fn test_reset_clears_buffer_and_state() {
        let mut hpss = HpssSeparator::new(15, 64);
        let click_frame = [1.0f32; 64];
        hpss.process_frame(&click_frame);
        assert_ne!(hpss.latest(), (0.0, 0.0));

        hpss.reset();
        assert_eq!(hpss.latest(), (0.0, 0.0));

        let silence = [0.0f32; 64];
        let (h, p) = hpss.process_frame(&silence);
        assert_eq!(h, 0.0);
        assert_eq!(p, 0.0);
    }
}
