# How the selectable scenes interpret audio

Every scene receives the same `RenderAudio` frame and the current visual settings. Each scene chooses its own inputs, smoothing, and mapping; the backend does not send scene-specific data. `VisualEngine` calls the active scene once per animation frame.

## Shared renderer-side controls

- **Sensitivity** scales a scene's input drive. Most scenes use `getEffectiveSensitivity`; Spectrum Bars has its own level calibration.
- **Response style** selects a dynamic profile with different attack/release smoothing and bass/transient multipliers. Scenes with a `BeatFollower` also use onset and, when confident, phase-locked timing.
- **Palette** supplies three colors (`a`, `b`, `c`). A scene decides how those colors map across geometry and time.
- **Silence** gates audio-driven inputs to zero. Ambient animation can continue, but it is not represented as a detected beat.

## Oscilloscope

The current Oscilloscope scene is a generated harmonic/Lissajous trace, not a direct plot of the backend's `waveform` array. It builds a 1200-point curve from sine and cosine components. Smoothed bass changes the horizontal amplitude and harmonic frequency; mids change vertical amplitude and harmonic frequency; transient energy shifts phase and brightens the trace; treble and sampled spectrum values add fine ripple. The selected three-stop palette is interpolated along the line, with a second offset glow line. During silence the curve retains slow ambient movement while audio-driven band targets go to zero.

## Geometric Tunnel

Tunnel feeds the three bands and the richer beat-following features (kick, transient, flatness, harmonic/percussive energy, chroma, phase, confidence, and stereo width) through `BeatFollower`, then maps bounded values to shader uniforms.

- Bass, kick, and transient push tunnel depth and ring flow.
- Mids twist the cross-section, vary the six/eight-sided contours, and modulate ring spacing.
- Treble adds short shimmer on ring and support edges.
- Flatness changes facet distortion; predictive beats and kick/transient energy add restrained flashes.
- The three palette colors are mixed along tunnel depth and the selected response style controls smoothing.

The shader also has a slow base flow while silent, so the tunnel does not freeze when playback pauses.

## Spectrum Bars

Bars prefers the 64 Mel values to build a mirrored 3D spectrum, placing low frequencies near the center and higher frequencies toward the edges. It samples nearby frequency bins for each bar, applies sensitivity calibration, and eases bar heights toward their targets. The beat follower contributes bass/mid/treble support, percussive energy, kick, chroma, and beat accents.

Sub-bass brightens the reflective floor and expands the floor ring. A measured beat edge, confident phase wrap, or onset fallback from kick/transient timing launches an outward floor shockwave. The shockwave lights the shader floor ripples and also lifts bars as it passes beneath them; peak caps respond to bar rises. Palette colors run across the bars and floor, with chroma shifting hue. Small baseline motion remains during silence.

## Particle Sphere

Particle Sphere maintains a steady shell of particles that move outward from a sphere surface. Bass/kick expands the emitter and particle size; mids tilt and rotate the shell; treble raises trail visibility and contributes to emission energy. A rising beat edge (or sufficiently strong kick/transient fallback) causes a short, faster particle burst and a decaying global pulse. HPSS percussive energy also contributes to that burst strength.

Each particle is assigned one of the palette's three colors in a repeating sequence, so the full selected palette appears together. Quality changes adjust steady emission and the maximum live-particle count. Particle age controls fade-in, hold, and fade-out; a subset carries short trails. During silence, ambient emission and slow rotation persist without beat bursts.

## Scene availability

The current experience controls expose these four scenes. The registry also contains implementations such as Vinyl and Fractal that are not in the selectable scene list; they are not presented here as available UI scenes. The backend frame remains scene-independent, so adding a selectable scene does not require a new capture or transport format.
