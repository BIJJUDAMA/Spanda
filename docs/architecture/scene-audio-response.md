# How the selectable scenes interpret audio

Every scene receives the same `RenderAudio` frame and the current visual settings. Each scene chooses its own inputs, smoothing, and mapping; the backend does not send scene-specific data. `VisualEngine` calls the active scene once per animation frame.

## Shared renderer-side controls

- **Sensitivity** scales a scene's input drive. Most scenes use `getEffectiveSensitivity`; Spectrum Bars has its own level calibration.
- **Response style** selects a dynamic profile with different attack/release smoothing and bass/transient multipliers. Scenes with a `BeatFollower` also use onset and, when confident, phase-locked timing.
- **Palette** supplies three colors (`a`, `b`, `c`). A scene decides how those colors map across geometry and time.
- **Silence** gates audio-driven inputs to zero. Existing visual envelopes can decay, while ambient animation continues without new detected beat accents.
- **Quality** changes the engine's internal render resolution. Some scenes also vary their particle budgets; not every scene needs quality-dependent geometry.

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

## Shared accents for Constellation, Liquid, Typography, and Kaleidoscope

These four scenes use `SceneBeatResponse` in `src/visualizers/beat-response.ts`. It consumes the existing `RenderAudio` contract rather than introducing scene-specific native events.

- A rising reported `beat` flag can trigger an accent even when band levels are unchanged.
- Frontend phase-wrap accents require confidence of at least 0.55. This is distinct from the backend threshold used to produce its own reported beat flag.
- Positive kick, transient, or bass changes provide onset fallback. A short refractory period avoids counting the same attack twice.
- Sensitivity scales accent strength; Dynamics supplies attack, release, and beat-intensity parameters.
- Held beat flags do not repeatedly retrigger. BPM alone does not create an oscillator. Silent input prevents new accents, including from stale beat/phase metadata.

Surface shaders receive `uBeat`, `uBeatAge`, and an integrated `uFlowTime`. The flow clock changes speed with active audio without multiplying absolute elapsed time by a changing level, avoiding abrupt phase jumps.

## Particle Constellation

The scene retains the original Fibonacci-distributed 128-point 3D constellation, perspective camera framing, distance-based links, and very slow rotation (0.008 radians/second). It contains points and lines, not a filled polyhedral surface.

Slow radial displacement moves neighboring nodes inward and outward. The shared beat envelope adds expansion and directional pulls; mids and transients retain their original size/energy response. Per-point palette interpolation and matching line-endpoint colors expose all three palette anchors together.

Density grows by 0.2 node per rendered second and 0.4 per detected accent, up to 256 nodes. Existing points keep their identities and coordinates as density grows. New points use additional low-discrepancy directions, and their RGBA opacity eases in; new connections inherit endpoint opacity. Original links receive priority before added links. Point and link buffers are preallocated, with at most 768 edges. Density resets on scene recreation; it is not a saved setting. Time-based growth during silence is ambient behavior, not a claimed beat.

Front-facing nodes twinkle at staggered, deterministic phases with smooth brightening and fading; beats amplify those sparkles. Compact cores and subtle star rays replace broad halos and sustained haze. Depth weighting fades the effect to zero toward the rear hemisphere, while palette colors and growth opacity remain shared with the original nodes. The camera is slightly closer (7.4 instead of 8) for modestly larger framing, including the existing portrait adjustment. Mesh lines receive no extra beat-brightness boost; geometry, density growth and slow reshaping remain unchanged.

## Liquid Interference

Three moving ripple sources respond independently to bass, mids, and treble. Active audio increases the integrated flow rate; mild domain distortion gives the pattern more movement. Beat age drives an outward ring, while the shared envelope controls its visibility and a small geometric expansion. Palette colors follow interference intensity. Silence leaves gentle source movement without new beat rings.

## Typography

Typography draws up to 48 characters into a reusable 1536x512 canvas texture. It redraws the texture only when text changes. The shader fits the text to the viewport, then applies band-driven waves and a restrained beat scale/stretch, vertical bounce, and edge echo. Palette interpolation colors the text; there is no external font service or lyrics lookup. The texture is disposed with the scene.

## Kaleidoscope

The shader mirrors a polar pattern into twelve sectors. Bass and the shared beat envelope change radial unfolding; mids distort the pattern; beat accents also provide a small angle/ridge response without accelerating the base rotation.

High-frequency detail has a separate path so it remains visible without a bass hit:

1. Combine the native treble band with peak/RMS detail from the upper 23% of logarithmic spectrum buckets (approximately 4kHz upward at normal 44.1/48kHz capture).
2. Apply sensitivity and soft compression to reveal quiet detail without flattening all louder input into a maximum value.
3. Use a 6-25ms attack and Dynamics-dependent release for the high-level envelope, plus a short positive-rise accent.
4. Drive finer facets, localized shimmer/sparkle, and subtle refraction. Bound highlights instead of flashing the whole frame white.

Silent input gates both high-frequency sources, allowing their envelopes to settle to zero. This is renderer-side mapping; WASAPI capture and backend frequency extraction are unchanged.

## Scene availability and lifecycle

The canonical selectable list is `src/visualizers/catalog.ts`: Oscilloscope, Geometric Tunnel, Spectrum Bars, Particle Sphere, Particle Constellation, Liquid Interference, Typography, and Kaleidoscope. The scene picker, rotation chooser, and saved-setting validation share this list. The registry also contains internal Vinyl and Fractal implementations that are not exposed as selectable scenes.

`VisualEngine` creates scenes through the registry, feeds them audio/settings each animation frame, applies render-scale resizing and postprocessing, and disposes replaced scene resources. Crossfades use a frozen GPU snapshot, keeping one active scene update loop. Reduced-motion mode skips the scene crossfade. Recording subscribers receive the final canvas after the visual transition has been composited.

Automated mapping and lifecycle tests establish these contracts. Live music timing, visual legibility, and GPU performance require manual verification on Windows.
