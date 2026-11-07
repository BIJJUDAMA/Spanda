use spanda_lib::audio::{
    analysis::Analyzer,
    types::{AudioBlock, AudioFormat},
};
use std::time::Instant;

#[test]
fn test_audio_pipeline_profiling_latency() {
    let sample_rate = 48000;
    let channels = 2;
    let hop_size = 512;
    let num_hops = 1000;

    let format = AudioFormat {
        sample_rate,
        channels,
    };

    // Pre-generate 1,000 hops of simulated stereo audio (sine wave + transients)
    // so data generation overhead does not pollute the benchmark.
    let mut blocks = Vec::with_capacity(num_hops);
    let mut phase_l = 0.0f32;
    let mut phase_r = 0.0f32;
    let freq_l = 440.0f32; // A4
    let freq_r = 554.37f32; // C#5
    let delta_l = 2.0 * std::f32::consts::PI * freq_l / sample_rate as f32;
    let delta_r = 2.0 * std::f32::consts::PI * freq_r / sample_rate as f32;

    for hop in 0..num_hops {
        let mut samples = Vec::with_capacity(hop_size * channels as usize);
        let is_transient_hop = hop % 40 == 0; // Periodic beat/transient every ~426ms

        for sample_idx in 0..hop_size {
            let mut left = 0.3 * phase_l.sin();
            let mut right = 0.3 * phase_r.sin();

            if is_transient_hop && sample_idx < 64 {
                // Sharp kick / transient pulse
                let transient = 0.7 * (1.0 - (sample_idx as f32 / 64.0));
                left += transient;
                right += transient;
            }

            samples.push(left);
            samples.push(right);

            phase_l = (phase_l + delta_l) % (2.0 * std::f32::consts::PI);
            phase_r = (phase_r + delta_r) % (2.0 * std::f32::consts::PI);
        }

        blocks.push(AudioBlock {
            format,
            samples,
            discontinuity: false,
        });
    }

    let mut analyzer = Analyzer::new(sample_rate);

    // Profile 1,000 hops through the complete analysis pipeline
    let start_time = Instant::now();
    for block in &blocks {
        analyzer.push(block);
    }
    let total_elapsed = start_time.elapsed();

    let total_elapsed_secs = total_elapsed.as_secs_f64();
    let avg_frame_time_ms = (total_elapsed_secs * 1000.0) / (num_hops as f64);
    let real_time_budget_ms = (hop_size as f64 * 1000.0) / (sample_rate as f64); // 10.666... ms
    let real_time_multiplier = real_time_budget_ms / avg_frame_time_ms;

    println!("\n=======================================================");
    println!("--- Full Audio Pipeline Profiling & Latency Benchmark ---");
    println!("Total Hops: {}", num_hops);
    println!("Hop Size: {} samples @ {} Hz", hop_size, sample_rate);
    println!(
        "Total Elapsed Time: {:.3} ms ({:.4} s)",
        total_elapsed_secs * 1000.0,
        total_elapsed_secs
    );
    println!("Average Frame Execution Time: {:.4} ms", avg_frame_time_ms);
    println!(
        "Real-Time Budget: {:.4} ms (512-sample hop)",
        real_time_budget_ms
    );
    println!(
        "Real-Time Multiplier: {:.2}x faster than real-time",
        real_time_multiplier
    );
    println!("=======================================================\n");

    // Ensure the output frame is valid and calculated
    let latest = analyzer.latest();
    assert!(latest.rms > 0.0, "RMS should be non-zero");
    assert!(!latest.centroid.is_nan(), "Centroid should not be NaN");

    // Requirement: Assert that average frame execution time is strictly < 4.0 ms
    assert!(
        avg_frame_time_ms < 4.0,
        "Average frame execution time ({:.4} ms) exceeded 4.0 ms budget limit",
        avg_frame_time_ms
    );
}
