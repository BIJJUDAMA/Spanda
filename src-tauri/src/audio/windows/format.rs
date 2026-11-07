use crate::audio::types::{AudioFormat, CaptureError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleEncoding {
    Float,
    SignedPcm,
}

/// Little-endian, tightly interleaved samples. Signed PCM valid bits are
/// left-aligned in their container; low padding bits are discarded.
/// The OS adapter parses native format structures into this plain descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SampleFormat {
    pub audio: AudioFormat,
    pub encoding: SampleEncoding,
    pub container_bits: u16,
    pub valid_bits: u16,
}

/// Replaces output, reusing its allocation. Invalid input leaves samples intact.
/// Non-silent input must contain exactly `frames` complete interleaved frames.
/// Silent packets ignore bytes but still require a supported, valid format.
pub fn decode_packet(
    bytes: &[u8],
    format: &SampleFormat,
    frames: usize,
    silent: bool,
    output: &mut Vec<f32>,
) -> Result<(), CaptureError> {
    if format.audio.sample_rate == 0 || format.audio.channels == 0 {
        return Err(error(
            "invalid_format",
            "Sample rate and channel count must be nonzero",
        ));
    }
    let supported = match format.encoding {
        SampleEncoding::Float => format.container_bits == 32 && format.valid_bits == 32,
        SampleEncoding::SignedPcm => {
            matches!(format.container_bits, 16 | 24 | 32)
                && format.valid_bits > 0
                && format.valid_bits <= format.container_bits
        }
    };
    if !supported {
        return Err(error("unsupported_format", &format!(
            "Unsupported {:?} format: {} container bits, {} valid bits; expected float32 or signed PCM16/24/32",
            format.encoding, format.container_bits, format.valid_bits
        )));
    }

    let sample_bytes = usize::from(format.container_bits / 8);
    let sample_count = frames
        .checked_mul(usize::from(format.audio.channels))
        .ok_or_else(|| error("invalid_packet", "Packet sample count overflow"))?;
    let byte_count = sample_count
        .checked_mul(sample_bytes)
        .ok_or_else(|| error("invalid_packet", "Packet byte count overflow"))?;
    // Validate the decoded size even for silence, where no input bytes exist.
    sample_count
        .checked_mul(std::mem::size_of::<f32>())
        .filter(|&size| size <= isize::MAX as usize)
        .ok_or_else(|| {
            error(
                "invalid_packet",
                "Decoded packet exceeds addressable buffer size",
            )
        })?;
    if !silent && bytes.len() != byte_count {
        return Err(error(
            "invalid_packet",
            &format!(
                "Expected {byte_count} bytes for {frames} frames, received {}",
                bytes.len()
            ),
        ));
    }
    output
        .try_reserve(sample_count.saturating_sub(output.len()))
        .map_err(|_| {
            error(
                "allocation_failed",
                "Unable to reserve decoded audio buffer",
            )
        })?;
    output.clear();
    if silent {
        output.resize(sample_count, 0.0);
        return Ok(());
    }

    for sample in bytes.chunks_exact(sample_bytes) {
        let value = match format.encoding {
            SampleEncoding::Float => {
                let value = f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]);
                if value.is_finite() {
                    value.clamp(-1.0, 1.0)
                } else {
                    0.0
                }
            }
            SampleEncoding::SignedPcm => {
                let signed = match sample_bytes {
                    2 => i32::from(i16::from_le_bytes([sample[0], sample[1]])),
                    3 => i32::from_le_bytes([
                        sample[0],
                        sample[1],
                        sample[2],
                        if sample[2] & 0x80 == 0 { 0 } else { 0xff },
                    ]),
                    4 => i32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]),
                    _ => unreachable!("validated signed PCM container"),
                };
                let valid = signed >> (format.container_bits - format.valid_bits);
                valid as f32 / (1_u64 << (format.valid_bits - 1)) as f32
            }
        };
        output.push(value);
    }
    Ok(())
}

fn error(code: &str, message: &str) -> CaptureError {
    CaptureError {
        code: code.into(),
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format(encoding: SampleEncoding, container_bits: u16, valid_bits: u16) -> SampleFormat {
        SampleFormat {
            audio: AudioFormat {
                sample_rate: 48_000,
                channels: 2,
            },
            encoding,
            container_bits,
            valid_bits,
        }
    }

    #[test]
    fn float_pcm_is_finite() {
        let input = [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -2.0, 2.0, 0.25];
        let bytes: Vec<_> = input.into_iter().flat_map(f32::to_le_bytes).collect();
        let mut output = Vec::new();
        decode_packet(
            &bytes,
            &format(SampleEncoding::Float, 32, 32),
            3,
            false,
            &mut output,
        )
        .unwrap();
        assert_eq!(output, [0.0, 0.0, 0.0, -1.0, 1.0, 0.25]);
    }

    #[test]
    fn pcm16_endpoints() {
        let mut output = Vec::new();
        decode_packet(
            &[0, 128, 255, 127],
            &format(SampleEncoding::SignedPcm, 16, 16),
            1,
            false,
            &mut output,
        )
        .unwrap();
        assert_eq!(output, [-1.0, 32767.0 / 32768.0]);
    }

    #[test]
    fn pcm24_sign_extension() {
        let mut output = Vec::new();
        let bytes = [0, 0, 128, 255, 255, 255, 255, 255, 127, 0, 0, 64];
        decode_packet(
            &bytes,
            &format(SampleEncoding::SignedPcm, 24, 24),
            2,
            false,
            &mut output,
        )
        .unwrap();
        assert_eq!(
            output,
            [-1.0, -1.0 / 8_388_608.0, 8_388_607.0 / 8_388_608.0, 0.5]
        );
    }

    #[test]
    fn pcm32_valid_bits() {
        // 24 valid bits: minimum, -1, maximum, zero with nonzero padding.
        let bytes = [
            0, 0, 0, 128, 255, 255, 255, 255, 255, 255, 255, 127, 255, 0, 0, 0,
        ];
        let mut output = Vec::new();
        decode_packet(
            &bytes,
            &format(SampleEncoding::SignedPcm, 32, 24),
            2,
            false,
            &mut output,
        )
        .unwrap();
        assert_eq!(
            output,
            [-1.0, -1.0 / 8_388_608.0, 8_388_607.0 / 8_388_608.0, 0.0]
        );
        decode_packet(
            &[0, 0, 0, 128, 0, 0, 0, 64],
            &format(SampleEncoding::SignedPcm, 32, 32),
            1,
            false,
            &mut output,
        )
        .unwrap();
        assert_eq!(output, [-1.0, 0.5]);
    }

    #[test]
    fn silent_packet_needs_no_bytes() {
        let mut output = vec![0.75; 16];
        decode_packet(
            &[],
            &format(SampleEncoding::Float, 32, 32),
            3,
            true,
            &mut output,
        )
        .unwrap();
        assert_eq!(output, [0.0; 6]);
    }

    #[test]
    fn malformed_packet_rejected() {
        let pcm = format(SampleEncoding::SignedPcm, 16, 16);
        let mut no_channels = pcm;
        no_channels.audio.channels = 0;
        let mut no_rate = pcm;
        no_rate.audio.sample_rate = 0;
        let cases: &[(&[u8], SampleFormat, usize, bool, &str)] = &[
            (&[0, 0, 0], pcm, 1, false, "invalid_packet"),
            (&[0; 5], pcm, 1, false, "invalid_packet"),
            (&[], pcm, usize::MAX, true, "invalid_packet"),
            (&[], no_channels, 1, true, "invalid_format"),
            (&[], no_rate, 1, true, "invalid_format"),
            (
                &[],
                format(SampleEncoding::Float, 64, 64),
                1,
                true,
                "unsupported_format",
            ),
            (
                &[],
                format(SampleEncoding::Float, 32, 24),
                1,
                true,
                "unsupported_format",
            ),
            (
                &[],
                format(SampleEncoding::SignedPcm, 8, 8),
                1,
                true,
                "unsupported_format",
            ),
            (
                &[],
                format(SampleEncoding::SignedPcm, 16, 0),
                1,
                true,
                "unsupported_format",
            ),
            (
                &[],
                format(SampleEncoding::SignedPcm, 24, 25),
                1,
                true,
                "unsupported_format",
            ),
        ];
        for &(bytes, sample_format, frames, silent, code) in cases {
            let mut output = vec![0.25];
            let error =
                decode_packet(bytes, &sample_format, frames, silent, &mut output).unwrap_err();
            assert_eq!(error.code, code, "{sample_format:?}");
            assert!(!error.message.is_empty());
            assert_eq!(
                output,
                [0.25],
                "errors must leave the previous output intact"
            );
        }
    }

    #[test]
    fn output_reuses_capacity_and_replaces_previous_packet() {
        let mut output = Vec::with_capacity(16);
        let pointer = output.as_ptr();
        let capacity = output.capacity();
        let pcm = format(SampleEncoding::SignedPcm, 16, 16);
        decode_packet(&[0, 64, 0, 192, 0, 0, 0, 0], &pcm, 2, false, &mut output).unwrap();
        assert_eq!(output, [0.5, -0.5, 0.0, 0.0]);
        decode_packet(&[0; 4], &pcm, 1, false, &mut output).unwrap();
        assert_eq!(output, [0.0, 0.0]);
        assert_eq!(output.as_ptr(), pointer);
        assert_eq!(output.capacity(), capacity);
        decode_packet(&[], &pcm, 0, false, &mut output).unwrap();
        assert!(output.is_empty());
    }
}
