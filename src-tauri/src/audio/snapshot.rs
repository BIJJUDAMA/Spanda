use super::{capture::CaptureState, types::CaptureError};

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedAnalysisFrame {
    pub rms: f32,
    pub peak: f32,
    pub sub_bass: f32,
    pub kick: f32,
    pub mids: f32,
    pub treble: f32,
    pub bands: [f32; 3],    // [sub_bass + kick, mids, treble]
    pub mel: Vec<f32>,      // 64 mel bins
    pub spectrum: Vec<f32>, // 64 bins
    pub flux: f32,
    pub transient: f32,
    pub beat: bool,
    pub phase: f32,
    pub bpm: f32,
    pub confidence: f32,
    pub h_energy: f32,
    pub p_energy: f32,
    pub chroma: [f32; 12],
    pub centroid: f32,
    pub flatness: f32,
    pub stereo_width: f32,
    pub left_peak: f32,
    pub right_peak: f32,
    pub waveform: Vec<f32>, // 64 samples
}

impl Default for UnifiedAnalysisFrame {
    fn default() -> Self {
        Self {
            rms: 0.0,
            peak: 0.0,
            sub_bass: 0.0,
            kick: 0.0,
            mids: 0.0,
            treble: 0.0,
            bands: [0.0; 3],
            mel: vec![0.0; 64],
            spectrum: vec![0.0; 64],
            flux: 0.0,
            transient: 0.0,
            beat: false,
            phase: 0.0,
            bpm: 0.0,
            confidence: 0.0,
            h_energy: 0.0,
            p_energy: 0.0,
            chroma: [0.0; 12],
            centroid: 0.0,
            flatness: 0.0,
            stereo_width: 0.0,
            left_peak: 0.0,
            right_peak: 0.0,
            waveform: vec![0.0; 64],
        }
    }
}

pub type AnalysisFrame = UnifiedAnalysisFrame;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSnapshot {
    pub generation: u32,
    pub sequence: u32,
    pub state: CaptureState,
    pub error: Option<CaptureError>,
    pub device_name: Option<String>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
    pub analysis: UnifiedAnalysisFrame,
    pub silent: bool,
}

impl Default for CaptureSnapshot {
    fn default() -> Self {
        Self {
            generation: 0,
            sequence: 0,
            state: CaptureState::Idle,
            error: None,
            device_name: None,
            sample_rate: None,
            channels: None,
            analysis: UnifiedAnalysisFrame::default(),
            silent: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_frame_has_expected_dimensions_and_zeroes() {
        let frame = UnifiedAnalysisFrame::default();
        assert_eq!(frame.rms, 0.0);
        assert_eq!(frame.peak, 0.0);
        assert_eq!(frame.sub_bass, 0.0);
        assert_eq!(frame.kick, 0.0);
        assert_eq!(frame.mids, 0.0);
        assert_eq!(frame.treble, 0.0);
        assert_eq!(frame.bands, [0.0; 3]);
        assert_eq!(frame.mel.len(), 64);
        assert!(frame.mel.iter().all(|&x| x == 0.0));
        assert_eq!(frame.spectrum.len(), 64);
        assert!(frame.spectrum.iter().all(|&x| x == 0.0));
        assert_eq!(frame.flux, 0.0);
        assert_eq!(frame.transient, 0.0);
        assert!(!frame.beat);
        assert_eq!(frame.phase, 0.0);
        assert_eq!(frame.bpm, 0.0);
        assert_eq!(frame.confidence, 0.0);
        assert_eq!(frame.h_energy, 0.0);
        assert_eq!(frame.p_energy, 0.0);
        assert_eq!(frame.chroma, [0.0; 12]);
        assert_eq!(frame.centroid, 0.0);
        assert_eq!(frame.flatness, 0.0);
        assert_eq!(frame.stereo_width, 0.0);
        assert_eq!(frame.left_peak, 0.0);
        assert_eq!(frame.right_peak, 0.0);
        assert_eq!(frame.waveform.len(), 64);
        assert!(frame.waveform.iter().all(|&x| x == 0.0));
    }

    #[test]
    fn serialization_camel_case_roundtrip() {
        let frame = UnifiedAnalysisFrame {
            rms: 0.42,
            sub_bass: 0.85,
            kick: 0.6,
            beat: true,
            bpm: 124.0,
            stereo_width: 0.75,
            left_peak: 0.5,
            right_peak: 0.45,
            h_energy: 0.3,
            p_energy: 0.7,
            ..Default::default()
        };

        let json = serde_json::to_string(&frame).expect("serialize frame");
        assert!(json.contains("\"subBass\":0.85"));
        assert!(json.contains("\"stereoWidth\":0.75"));
        assert!(json.contains("\"leftPeak\":0.5"));
        assert!(json.contains("\"rightPeak\":0.45"));
        assert!(json.contains("\"hEnergy\":0.3"));
        assert!(json.contains("\"pEnergy\":0.7"));
        assert!(json.contains("\"beat\":true"));
        assert!(json.contains("\"bpm\":124.0"));

        let deserialized: UnifiedAnalysisFrame =
            serde_json::from_str(&json).expect("deserialize frame");
        assert_eq!(frame, deserialized);
    }
}
