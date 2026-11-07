#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct CaptureError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

/// Interleaved, finite samples in [-1, 1], in complete channel frames.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioBlock {
    pub format: AudioFormat,
    pub samples: Vec<f32>,
    /// Samples before this block are not contiguous with this block.
    pub discontinuity: bool,
}
