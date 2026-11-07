# Analysis frame and frontend audio flow

This document describes how Rust's measurements cross Tauri and become the reusable audio input read by the visualizer engine.

## Shared frame contract

Rust serializes `UnifiedAnalysisFrame` using camelCase field names. The TypeScript counterpart is `UnifiedAnalysisFrame` in `src/audio/types.ts`.

| Field | Shape | Meaning and use |
| --- | --- | --- |
| `rms`, `peak` | number | Block/window level and peak. Used by diagnostics and as broad activity/level information. |
| `subBass`, `kick`, `mids`, `treble` | number each | Individually normalized frequency-band measurements. |
| `bands` | 3 numbers | `[subBass + kick, mids, treble]`; frontend maps these to bass, mid, and treble render controls. |
| `mel`, `spectrum` | 64 numbers each | Mel-scaled energy and log-frequency spectrum. Bars prefer `mel`, with `spectrum` as fallback; other scenes may sample spectrum. |
| `flux`, `transient` | number each | Kick-onset flux strength; currently the two values are equal in the Rust analyzer. |
| `beat` | boolean | Measured onset or confidence-gated predictive beat from the beat tracker. |
| `phase`, `bpm`, `confidence` | number each | Beat phase, tempo estimate, and tracker confidence. |
| `hEnergy`, `pEnergy` | number each | Harmonic/percussive separation energy; scenes use percussive energy to accent attacks. |
| `chroma` | 12 numbers | Pitch-class energy used for color/hue shifts in scenes that consume it. |
| `centroid`, `flatness` | number each | Spectral brightness and noisiness descriptors. |
| `stereoWidth`, `leftPeak`, `rightPeak` | number each | Stereo image and channel levels for diagnostics or scene modulation. |
| `waveform` | 64 numbers | Downsampled mono samples from the analysis window. Available to scenes that draw a waveform-derived trace. |

Analysis values are normalized by the backend where applicable, but their perceptual response is not uniform: band AGC, onset detection, and tempo confidence each have their own history and scale. Scene code applies additional sensitivity, smoothing, and visual mapping. The frame should therefore be read as a set of analysis features, not as calibrated physical units.

## Tauri transport

The frontend client listens for the `audio_frame` event. In parallel, it invokes `get_snapshot` approximately every 33 ms for capture state, diagnostics, and fallback analysis. Start/stop use `start_capture` and `stop_capture` commands. A generation and sequence on each snapshot let the store reject stale snapshots from a prior session.

The push stream is preferred for render data while recent push frames are arriving. Poll snapshots remain useful if event listening is unavailable or paused. The store takes the three `bands` values (with legacy component fallbacks) into a reusable `RenderAudio` object, copies up to 64 spectrum buckets into a reusable `Float32Array`, and forwards mel, beat, phase, chroma, waveform, and the other features for scenes that need them.

The client treats capture state and signal data separately. `idle`, `starting`, `recovering`, or stale frames become silent visual input; between valid frames, render values decay smoothly and transient energy decays faster. This avoids holding a frozen peak or treating ambient animation as detected sound. When capture stops or the app disposes the client, it clears timers/listeners and resets the UI-facing audio state.

## UI and render responsibilities

`App.tsx` owns the audio client and capture controls. React subscribes to state changes for the HUD and controls. The animation loop in `VisualEngine` reads the current `RenderAudio` directly once per frame and calls `activeScene.update(dt, audio, settings)`. The engine also handles resize, quality scaling, scene replacement, and disposal. This keeps per-frame scene updates outside React's render cycle.

The selected response style and sensitivity are not backend DSP settings. They are renderer-side controls: scenes smooth and scale the already-produced analysis values for visual motion. Color palette is also a frontend setting. The Rust backend publishes features independently of the selected scene or palette.

## Limits and interpretation

- A `beat` flag is the backend tracker output, not a guarantee that every musical beat will be found or that the estimate is correct for every genre.
- `transient` describes onset flux, not a universal percussion classifier.
- `phase` and `bpm` are useful only when tracker confidence is sufficient; scenes can use immediate onset fallbacks while the tracker is not locked.
- `waveform` contains 64 samples selected across a 4096-sample window. It is a downsampled display signal, not a lossless audio stream.
- The renderer keeps ambient scene motion during silence, but it zeros audio-driven targets when `silent` is true.
