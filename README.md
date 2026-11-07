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
Spanda listens to the combined audio playing through the Windows default output and turns it into responsive visuals. Choose a scene and color palette, tune how strongly it reacts, and switch to full screen when you want the visuals to fill the display.

Spanda is a visualizer, not a player or audio router. It does not change playback volume or select an output device. System audio capture starts only when you press **Start**.

## Features

- **Windows system audio capture:** captures the Windows default playback endpoint through WASAPI loopback and follows default-output changes while running.
- **Four visual scenes:** Oscilloscope, Geometric Tunnel, Spectrum Bars, and Particle Sphere. Oscilloscope is selected on launch.
- **Seven palettes:** Aurora, Ember, Cosmic, Cyberpunk, Synthwave, Matrix, and Monochrome.
- **Five response styles:** Punchy, Smooth, Hyper, Liquid, and Bouncy, for different visual motion and attack/release character.
- **Adjustable sensitivity:** tune the visual response to the level of your system audio.
- **Render quality controls:** Low, Balanced, and High use 50%, 75%, and 100% internal render scale, respectively. Actual performance depends on the PC and scene.
- **Immersive controls:** enter full screen, hide the controls when you want an unobstructed view, and bring them back with interaction.
- **Diagnostics:** inspect the live capture state and signal information while troubleshooting audio input.
- **Ambient idle motion:** scenes continue gentle motion during silence without presenting that motion as detected audio.

## Scenes

| Scene | What it shows |
| --- | --- |
| **Oscilloscope** | A generated harmonic trace whose shape, ripple, and brightness respond to captured bands and transients. This is the default scene; it is not a direct plot of the backend waveform samples. |
| **Geometric Tunnel** | A receding geometric tunnel with motion shaped by the audio. |
| **Spectrum Bars** | Frequency bars with audio-reactive movement and beat-triggered effects. |
| **Particle Sphere** | A three-dimensional particle sphere whose motion and color respond to the audio and selected palette. |

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Left / Right arrow | Change scene |
| Up / Down arrow | Change color palette |
| `H` | Hide Controls |
| `S` | Start or stop system audio capture |
| `D` | Toggle diagnostics |
| `F` or `F11` | Toggle full screen |
| `Esc` | Exit full screen |

The diagnostics panel also lists these shortcuts in the app.

## Requirements

- Windows 10 or Windows 11
- Node.js `^24.18.0` or `>=26.0.0` and npm
- Rust and Cargo
- Microsoft C++ Build Tools with the Visual Studio C++ workload
- WebView2 Runtime

## Run from source

Install JavaScript dependencies:

```powershell
npm install
```

Start the desktop app in development mode:

```powershell
npm run tauri dev
```

Build the Windows installer:

```powershell
npm run tauri build
```

The Tauri configuration currently targets an NSIS Windows installer.

## Development checks

Run the frontend type check and production web build:

```powershell
npm run build
```

Run the frontend test suite:

```powershell
npm test -- --run
```

Run Rust tests:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

For a manual Windows capture and device-switching checklist, see [`docs/testing/windows.md`](docs/testing/windows.md).

## Audio and visualizer architecture

These guides trace the signal from device capture through the Rust analysis pipeline and Tauri transport, then explain how the frontend maps analysis fields into each selectable scene:

- [Audio capture and analysis](docs/architecture/audio-capture-and-analysis.md)
- [Analysis frame and frontend audio flow](docs/architecture/analysis-frame-and-frontend.md)
- [How the selectable scenes interpret audio](docs/architecture/scene-audio-response.md)

## How it works

Spanda is a local desktop application built with **Tauri 2**, **Rust**, **React**, **TypeScript**, and **Three.js/WebGL**. The Windows capture adapter reads the default output using WASAPI loopback. Rust analyzes the captured audio and sends compact analysis frames to the frontend, where the visualizer engine updates the selected scene.

The main areas of the codebase are:

- `src-tauri/src/audio/` — audio capture, analysis, and session lifecycle.
- `src/audio/` — frontend audio data types, store, and native event client.
- `src/visualizers/` — rendering engine, palettes, dynamics, and scene implementations.
- `src/components/` and `src/App.tsx` — application controls, diagnostics, and desktop experience.

## Audio capture and privacy

Capture is opt-in and begins when you press **Start**. Spanda analyzes system playback locally; it does not upload audio to a server, play audio, or take control of system playback. Press **Stop** or close the app to end capture.

Capture follows the Windows default output device. Audio routed exclusively to a non-default output is not part of that captured mix. Windows, the device driver, or protected-content restrictions can also affect whether particular playback is available to loopback capture.

Spanda currently supports system playback capture on Windows. Microphone capture and other operating-system capture backends are not included.

## License

Spanda-authored material is provided under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License](LICENSE). This license applies only to material Spanda's authors have the rights to license; third-party software, fonts, and assets retain their respective licenses and terms.
