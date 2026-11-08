<div align="center">
  <img src="assets/banner.png" alt="Spanda - Where sound takes shape" width="100%" />

  <p><strong>A real-time, full-screen audio visualizer for Windows.</strong></p>

  <p>
    <img alt="Platform: Windows" src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white" />
    <img alt="Tauri 2" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" />
    <img alt="React 19" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
    <img alt="Rust" src="https://img.shields.io/badge/backend-Rust-000000?logo=rust&logoColor=white" />
    <img alt="License: CC BY-NC-SA 4.0" src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue" />
  </p>
</div>
<div align="center">
  <h1><b>SPANDA</b></h1>
  <p><i>Pronounced "spun-duh"</i></p>
</div>
Spanda turns the combined audio playing through the Windows default output into real-time visuals. Choose a scene and palette, adjust its response, and enter full screen.

System audio capture starts only when you press **Start**. Spanda does not change playback volume, route audio, or use your microphone.

## Features

- **Windows loopback capture:** follows the Windows default playback output through WASAPI.
- **Eight selectable scenes:** from an oscilloscope and spectrum bars to particles, liquid patterns, reactive text, and a kaleidoscope.
- **Audio-driven motion:** frequency bands, detected beats, tempo phase, transients, and scene-specific high-frequency detail.
- **Seven palettes:** Aurora, Ember, Cosmic, Cyberpunk, Synthwave, Matrix, and Monochrome.
- **Five dynamics styles:** Punch, Smooth, Hyper, Liquid, and Bounce.
- **Sensitivity and render quality:** control visual drive and choose 50%, 75%, or 100% internal resolution.
- **Remembered preferences:** restore visual settings and the last compact HUD tab after reopening.
- **Scene rotation:** choose scenes and a custom interval, with smooth crossfades.
- **Spotify desktop controls:** artwork, track details, transport controls, and seeking through the Windows media session.
- **Responsive glass HUD:** fullscreen controls, compact tabs, shortcut tooltips, and automatic hiding.
- **Diagnostics:** waveform, spectrum, stereo meters, signal levels in dBFS, BPM, and tempo confidence.
- **WebM recording:** clean visuals with system audio, saved locally.

## Scenes

| Scene | Response |
| --- | --- |
| **Oscilloscope** | A generated harmonic trace shaped by bands, spectrum, and transients. It is not a direct plot of raw waveform samples. |
| **Geometric Tunnel** | Depth, flow, twist, and edge shimmer respond to rhythm and frequency features. |
| **Spectrum Bars** | A mirrored spectrum with measured beat/onset shockwaves across the floor and bars. |
| **Particle Sphere** | A 3D particle shell with audio-driven expansion, rotation, emission, trails, and beat bursts. |
| **Particle Constellation** | Starts with 128 points and slowly grows to 256 through time and detected beats. Nodes pull inward/outward, beat accents expand the constellation, and new points/links fade in. Rotation stays very slow; all palette colors appear. |
| **Liquid Interference** | Overlapping ripples with stronger flow during audio, local distortion, and outward beat accents. |
| **Typography** | Your text responds with a restrained beat pop, bounce, wave distortion, and edge glow. Enter up to 48 characters in **Your words**. |
| **Kaleidoscope** | Mirrored geometry unfolds on beats. A separate fast treble response adds sharper facets, shimmer, sparkle, and subtle refraction. |

Detected beats and confident tempo phase drive the newer scene accents, with measured onset fallback when confidence is low. BPM is an estimate; Spanda does not assume every musical beat has been found. Silence keeps gentle ambient movement without generating new beat accents. Constellation growth also advances slowly with rendered time and resets when that scene is recreated.

## Using the HUD

1. Play audio through the Windows default output.
2. Press **Start** to begin visualization. **Stop** releases capture and leaves playback running.
3. Choose a scene, palette, Dynamics style, Sensitivity, and render quality.
4. Enter full screen or hide controls for an unobstructed view. Move the mouse to show them again.

Double-click the Sensitivity slider or value to restore **1.00x**. The value button also supports keyboard activation.

Scene, palette, sensitivity, dynamics, render quality, and typography text are stored locally. Audio capture, recording, and scene rotation remain off on launch. Invalid or unavailable saved settings fall back safely.

Desktop controls fit the available viewport height, including display scaling. Narrow or short windows use **Visuals**, **Spotify**, and **Diagnostics** tabs with compact selectors. Tab changes use a sliding highlight and interruptible panel transitions. Reduced-motion preferences are respected.

### Automatic scene rotation

Enable **Rotate scenes**, choose at least two scenes, and enter an interval from **1 to 3600 seconds**. Press Enter or leave the field to apply; Escape cancels an interval edit. The scene chooser supports keyboard navigation and Escape/outside-click dismissal. Manual scene changes restart the rotation timer. Disable rotation to stay on the current scene.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Left / Right arrow | Change scene |
| Up / Down arrow | Change palette |
| `H` | Hide controls |
| `S` | Start / stop system audio capture |
| `F` or `F11` | Toggle full screen |
| `Esc` | Exit full screen |

Inputs and menus use their own keyboard interactions while focused. Relevant controls show shortcut hints on hover. The diagnostics panel also lists shortcuts.

## Spotify desktop controls

Open the Spotify Windows desktop app and begin playback so it exposes a Windows media session. Spanda displays artwork, title, artist, album, playback state, and timeline. Play/pause, previous/next, and seeking are enabled when Spotify reports support. Hover over the timeline to preview the destination time before seeking.

If no Spotify desktop session is exposed, the HUD shows **Spotify unavailable**. Browser playback is excluded. This integration uses Windows GSMTC on Windows 10 version 1809 or later and Windows 11, without Spotify OAuth, login credentials, or Spicetify.

Spotify controls work independently of **Start/Stop**. Audio analysis and recording use the combined Windows default-output mix, not just Spotify. Track metadata does not drive beat detection.

## Recording with sound (experimental)

Press **Start**, then **Record clip** in the Visuals panel. Use **Stop & save** to finish. When the HUD is hidden, the **Recording** badge also stops and saves on click.

| Property | Current implementation |
| --- | --- |
| Format | WebM with VP9 video (VP8 fallback) and Opus audio |
| Destination | Windows Videos folder, inside `Spanda` |
| Picture | Visualizer canvas only; HUD excluded |
| Sound | Captured Windows default-output mix, including other applications |
| Resolution | Up to 1280x720, limited by the current render resolution |
| Frame rate | Up to 30 fps |
| Limits | Five minutes per clip; 512 MiB native file limit |
| Resize | Original recording dimensions remain fixed; visuals are fitted inside them |

Stopping capture or entering output recovery ends the recording and attempts to save it. Save before closing the app: closing cancels unfinished clips. Recording does not use a microphone, replay captured audio, or upload files.

**Verification status:** Recording uses WebM with system sound. The previous WebM path was exercised with live Windows loopback; the restored path still needs a fresh manual playback and audiovisual synchronization check. Unsupported WebView2 encoding, synchronization, and write failures produce an error rather than a successful-save message.

## Requirements and development

Using the desktop app requires Windows and the Microsoft Edge WebView2 Runtime. Spotify controls require a compatible Spotify desktop session; Spotify is optional for visualization.

Building from source additionally requires:

- Node.js `^24.18.0` or `>=26.0.0`, and npm.
- Rust and Cargo.
- Microsoft C++ Build Tools with the Visual Studio C++ workload.

```powershell
npm install
npm run tauri dev
```

Use `npm run tauri dev` for native capture, Spotify, and recording commands. `npm run dev` starts only the frontend server at `http://127.0.0.1:1420`. Dependency scanning is restricted to the application entry point.

Build the configured NSIS installer:

```powershell
npm run tauri build
```

The installer uses Spanda artwork while retaining Tauri's NSIS installation and upgrade flow. Regenerate installer bitmap artwork with `npm run installer:art` on Windows when changing its source logo/banner.

### Development checks

```powershell
npm run build
npm test -- --run --maxWorkers=1
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Known verification debt includes five existing assertions in older scene tests and an existing Clippy `needless_update` finding. A passing build or synthetic audio test does not establish live beat accuracy, audiovisual synchronization, or a 1080p/60 FPS performance guarantee. These checks require manual verification.

## Architecture

Spanda uses **Tauri 2**, **Rust**, **React/TypeScript**, and **Three.js/WebGL**. Capture and DSP stay separate from rendering. The native layer produces compact analysis frames; scenes read a reusable audio snapshot outside React's render cycle.

- [Audio capture and analysis](docs/architecture/audio-capture-and-analysis.md)
- [Analysis frame and frontend flow](docs/architecture/analysis-frame-and-frontend.md)
- [How scenes interpret audio](docs/architecture/scene-audio-response.md)
- [Recording architecture and validation](docs/architecture/recording.md)

Main source areas:

- `src-tauri/src/audio/`: capture adapters, analysis, and capture lifecycle.
- `src-tauri/src/media/`: Spotify Windows media-session discovery and controls.
- `src-tauri/src/recording.rs` and `src/recording/`: bounded recording transport, encoding, and saving.
- `src/audio/`: frontend contracts, store, and native event client.
- `src/visualizers/`: rendering engine, palettes, dynamics, and scene implementations.
- `src/components/` and `src/experience/`: HUD controls, preferences, rotation, and layout behavior.

## Future directions

These are possible larger features, not implemented features or a committed release schedule:

- **Custom audio mappings and preset packs:** choose which audio feature drives each effect, then save/share complete configurations.
- **Live performance and MIDI:** queue transitions, trigger effects, and map physical controls.
- **Multi-monitor output:** keep controls on one screen and clean visuals on a projector or second display.
- **Recording studio:** quality choices, a clip library, preview, and trimming after current export reliability is established.
- **Scene editor and custom shaders:** author visual behavior with documented audio inputs and safe error recovery.
- **Analysis improvements:** tune tempo confidence, onset timing, stereo response, and harmonic/percussive mappings against real music.
- **Local audio playback:** an optional future playback source, separate from the current system-loopback capture.

## Audio capture and privacy

Capture is opt-in and follows the Windows default output. Audio routed exclusively to another output is outside that mix; drivers and protected-content restrictions can also affect loopback availability.

Analysis stays local. Audio/video is written to disk only when recording is requested. Spotify controls read the desktop session locally and send playback commands when used; Spanda requests no Spotify account credentials. Microphone capture, other operating-system capture backends, and cloud services are not included.

## License

Spanda-authored material is provided under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License](LICENSE). This license applies only to material Spanda's authors have the rights to license; third-party software, fonts, and assets retain their respective licenses and terms.
