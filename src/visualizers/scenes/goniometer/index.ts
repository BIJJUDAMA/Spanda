import * as THREE from 'three';
import type { RenderAudio, VisualScene, VisualSettings } from '../../types';
import { smoothDynamic, DYNAMIC_PROFILES, getEffectiveSensitivity } from '../../dynamics';
import { PALETTES } from '../../palettes';

const TRACE_POINTS = 1200;
const SCATTER_POINTS = 600;
const CORR_ARC_SEGMENTS = 32;
const ELLIPSE_POINTS = 96;
const OUTER_RING_POINTS = 96;

// Goniometer geometry is deliberately measurement-led, but its energy accents
// need a soft ceiling so high-response profiles do not wash out the stereo trace.
function goniometerDrive(value: number): number {
  const positive = Number.isFinite(value) ? Math.max(0, value) : 0;
  return positive / (1 + positive * 0.6);
}

function unit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export class GoniometerScene implements VisualScene {
  public scene: THREE.Scene;
  public camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer;

  // Visual Elements
  private reticle: THREE.LineSegments;
  private reticleGeometry: THREE.BufferGeometry;
  private reticleMaterial: THREE.LineBasicMaterial;

  private outerRing: THREE.Line;
  private outerRingGeometry: THREE.BufferGeometry;
  private outerRingMaterial: THREE.LineBasicMaterial;
  private outerRingPositions: Float32Array;
  private outerRingColors: Float32Array;

  private ellipseLine: THREE.Line;
  private ellipseGeometry: THREE.BufferGeometry;
  private ellipseMaterial: THREE.LineBasicMaterial;
  private ellipsePositions: Float32Array;
  private ellipseColors: Float32Array;

  private traceLine: THREE.Line;
  private traceGeometry: THREE.BufferGeometry;
  private traceMaterial: THREE.LineBasicMaterial;
  private tracePositions: Float32Array;
  private traceColors: Float32Array;

  private glowLine: THREE.Line;
  private glowGeometry: THREE.BufferGeometry;
  private glowMaterial: THREE.LineBasicMaterial;
  private glowPositions: Float32Array;
  private glowColors: Float32Array;

  private scatterPoints: THREE.Points;
  private scatterGeometry: THREE.BufferGeometry;
  private scatterMaterial: THREE.PointsMaterial;
  private scatterPositions: Float32Array;
  private scatterColors: Float32Array;

  // Correlation Meter Elements
  private corrTrack: THREE.LineSegments;
  private corrTrackGeometry: THREE.BufferGeometry;
  private corrTrackMaterial: THREE.LineBasicMaterial;

  private corrIndicator: THREE.Line;
  private corrIndicatorGeometry: THREE.BufferGeometry;
  private corrIndicatorMaterial: THREE.LineBasicMaterial;
  private corrPositions: Float32Array;
  private corrColors: Float32Array;

  private ambientTime: number = 0;

  // Smoothed Audio Values
  public smoothedStereoWidth: number = 0;
  public smoothedBass: number = 0;
  public smoothedSubBass: number = 0;
  public smoothedMid: number = 0;
  public smoothedTransient: number = 0;
  public smoothedKick: number = 0;
  public smoothedPEnergy: number = 0;
  private smoothedBeatAccent = 0;

  // Correlation & Phase Angle
  public correlation: number = 1.0;
  public phaseAngle: number = Math.PI / 2;

  // Reticle layout parameters
  private readonly centerX = 0.0;
  private readonly centerY = 0.05;
  private readonly reticleRadius = 0.74;
  private readonly corrRadius = 0.88;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.77, 1.77, 1.0, -1.0, 0, 10);
    this.camera.position.z = 2;

    const cx = this.centerX;
    const cy = this.centerY;
    const R = this.reticleRadius;

    // 1. Construct Polar Reticle with Concentric dB Circles & Radial Division Rays
    const reticleLines: number[] = [];

    // Concentric Polar dB Circles:
    // -20 dB (0.22 R), -12 dB (0.38 R), -6 dB (0.55 R), 0 dB (0.75 R), +3 dB (1.0 R)
    const dbCircles = [
      { r: R * 0.22, segments: 48 },
      { r: R * 0.38, segments: 48 },
      { r: R * 0.55, segments: 64 },
      { r: R * 0.75, segments: 64 },
      { r: R * 1.00, segments: 96 },
    ];

    dbCircles.forEach(({ r: radius, segments }) => {
      for (let s = 0; s < segments; s++) {
        const a1 = (s / segments) * Math.PI * 2;
        const a2 = ((s + 1) / segments) * Math.PI * 2;
        reticleLines.push(
          cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius, 0,
          cx + Math.cos(a2) * radius, cy + Math.sin(a2) * radius, 0
        );
      }
    });

    // Radial Division Rays: 0° (+S), 45° (Mid/Side R), 90° (+M), 135° (Mid/Side L), 180° (-S),
    // and matching lower hemisphere rays 225°, 270°, 315°
    const rayAngles = [0, 45, 90, 135, 180, 225, 270, 315];
    rayAngles.forEach((deg) => {
      const rad = (deg * Math.PI) / 180;
      reticleLines.push(
        cx, cy, 0,
        cx + Math.cos(rad) * R, cy + Math.sin(rad) * R, 0
      );
    });

    // Axis Calibration Tick Marks at dB radii
    const tickLen = 0.016;
    dbCircles.forEach(({ r }) => {
      // Along M axis
      reticleLines.push(cx - tickLen, cy + r, 0, cx + tickLen, cy + r, 0);
      reticleLines.push(cx - tickLen, cy - r, 0, cx + tickLen, cy - r, 0);
      // Along S axis
      reticleLines.push(cx + r, cy - tickLen, 0, cx + r, cy + tickLen, 0);
      reticleLines.push(cx - r, cy - tickLen, 0, cx - r, cy + tickLen, 0);
    });

    // Outer Angular Division Ticks (every 15° with major ticks at 45° and 90°)
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const isMajor = deg % 45 === 0;
      const len = isMajor ? 0.032 : 0.015;
      const x1 = cx + Math.cos(rad) * R;
      const y1 = cy + Math.sin(rad) * R;
      const x2 = cx + Math.cos(rad) * (R - len);
      const y2 = cy + Math.sin(rad) * (R - len);
      reticleLines.push(x1, y1, 0, x2, y2, 0);
    }

    // Geometric Pole Badges / Reference Labels
    // 'M' at top (90°)
    const mY = cy + R + 0.035;
    const mW = 0.022;
    const mH = 0.026;
    reticleLines.push(
      cx - mW, mY - mH, 0, cx - mW, mY, 0,
      cx - mW, mY, 0, cx, mY - mH * 0.6, 0,
      cx, mY - mH * 0.6, 0, cx + mW, mY, 0,
      cx + mW, mY, 0, cx + mW, mY - mH, 0
    );

    // 'L' at top-left diagonal (+45° / 135°)
    const diag = R * Math.SQRT1_2;
    const lX = cx - diag - 0.035;
    const lY = cy + diag + 0.025;
    const lW = 0.018;
    const lH = 0.024;
    reticleLines.push(
      lX, lY, 0, lX, lY - lH, 0,
      lX, lY - lH, 0, lX + lW, lY - lH, 0
    );

    // 'R' at top-right diagonal (-45° / 45°)
    const rX = cx + diag + 0.022;
    const rY = cy + diag + 0.025;
    const rW = 0.018;
    const rH = 0.024;
    reticleLines.push(
      rX, rY - rH, 0, rX, rY, 0,
      rX, rY, 0, rX + rW, rY - rH * 0.25, 0,
      rX + rW, rY - rH * 0.25, 0, rX, rY - rH * 0.5, 0,
      rX, rY - rH * 0.5, 0, rX + rW, rY - rH, 0
    );

    // '+S' on left (180°) and '-S' on right (0°) horizontal ends
    const sLen = 0.018;
    // Left (+S side)
    reticleLines.push(
      cx - R - 0.03 - sLen, cy, 0, cx - R - 0.03 + sLen, cy, 0,
      cx - R - 0.03, cy - sLen, 0, cx - R - 0.03, cy + sLen, 0
    );
    // Right (-S side)
    reticleLines.push(
      cx + R + 0.03 - sLen, cy, 0, cx + R + 0.03 + sLen, cy, 0
    );

    this.reticleGeometry = new THREE.BufferGeometry();
    this.reticleGeometry.setAttribute('position', new THREE.Float32BufferAttribute(reticleLines, 3));
    this.reticleMaterial = new THREE.LineBasicMaterial({
      color: 0x334155,
      transparent: true,
      opacity: 0.42,
    });
    this.reticle = new THREE.LineSegments(this.reticleGeometry, this.reticleMaterial);
    this.scene.add(this.reticle);

    // 2. Glowing Outer Ring Pulsing to Audio Phase and Energy
    this.outerRingPositions = new Float32Array(OUTER_RING_POINTS * 3);
    this.outerRingColors = new Float32Array(OUTER_RING_POINTS * 3);
    this.outerRingGeometry = new THREE.BufferGeometry();
    this.outerRingGeometry.setAttribute('position', new THREE.BufferAttribute(this.outerRingPositions, 3));
    this.outerRingGeometry.setAttribute('color', new THREE.BufferAttribute(this.outerRingColors, 3));
    this.outerRingMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      linewidth: 2,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
    });
    this.outerRing = new THREE.Line(this.outerRingGeometry, this.outerRingMaterial);
    this.scene.add(this.outerRing);

    // 3. Dynamic Lissajous Phase Ellipse
    this.ellipsePositions = new Float32Array(ELLIPSE_POINTS * 3);
    this.ellipseColors = new Float32Array(ELLIPSE_POINTS * 3);
    this.ellipseGeometry = new THREE.BufferGeometry();
    this.ellipseGeometry.setAttribute('position', new THREE.BufferAttribute(this.ellipsePositions, 3));
    this.ellipseGeometry.setAttribute('color', new THREE.BufferAttribute(this.ellipseColors, 3));
    this.ellipseMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      linewidth: 2.5,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
    });
    this.ellipseLine = new THREE.Line(this.ellipseGeometry, this.ellipseMaterial);
    this.scene.add(this.ellipseLine);

    // 4. Floating Stereo Correlation Arc Base Track
    const corrArcLines: number[] = [];
    const rCorr = this.corrRadius;
    const startAngle = (-135 * Math.PI) / 180;
    const endAngle = (-45 * Math.PI) / 180;
    const arcSteps = 48;

    for (let i = 0; i < arcSteps; i++) {
      const a1 = startAngle + (i / arcSteps) * (endAngle - startAngle);
      const a2 = startAngle + ((i + 1) / arcSteps) * (endAngle - startAngle);
      corrArcLines.push(
        cx + Math.cos(a1) * rCorr, cy + Math.sin(a1) * rCorr, 0,
        cx + Math.cos(a2) * rCorr, cy + Math.sin(a2) * rCorr, 0
      );
    }

    // Arc Calibration Ticks: -1 (Left), -0.5, 0 (Center), +0.5, +1 (Right)
    const calibrationValues = [-1.0, -0.5, 0.0, 0.5, 1.0];
    calibrationValues.forEach((val) => {
      const angle = (-90 * Math.PI) / 180 + val * ((45 * Math.PI) / 180);
      const len = val === 0 || Math.abs(val) === 1 ? 0.035 : 0.02;
      const x1 = cx + Math.cos(angle) * (rCorr - len * 0.5);
      const y1 = cy + Math.sin(angle) * (rCorr - len * 0.5);
      const x2 = cx + Math.cos(angle) * (rCorr + len * 0.5);
      const y2 = cy + Math.sin(angle) * (rCorr + len * 0.5);
      corrArcLines.push(x1, y1, 0, x2, y2, 0);
    });

    this.corrTrackGeometry = new THREE.BufferGeometry();
    this.corrTrackGeometry.setAttribute('position', new THREE.Float32BufferAttribute(corrArcLines, 3));
    this.corrTrackMaterial = new THREE.LineBasicMaterial({
      color: 0x475569,
      transparent: true,
      opacity: 0.38,
    });
    this.corrTrack = new THREE.LineSegments(this.corrTrackGeometry, this.corrTrackMaterial);
    this.scene.add(this.corrTrack);

    // 5. Dynamic Correlation Indicator (Pointer + Fill Arc)
    const maxCorrPoints = CORR_ARC_SEGMENTS + 4;
    this.corrPositions = new Float32Array(maxCorrPoints * 3);
    this.corrColors = new Float32Array(maxCorrPoints * 3);
    this.corrIndicatorGeometry = new THREE.BufferGeometry();
    this.corrIndicatorGeometry.setAttribute('position', new THREE.BufferAttribute(this.corrPositions, 3));
    this.corrIndicatorGeometry.setAttribute('color', new THREE.BufferAttribute(this.corrColors, 3));
    this.corrIndicatorMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      linewidth: 3,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
    });
    this.corrIndicator = new THREE.Line(this.corrIndicatorGeometry, this.corrIndicatorMaterial);
    this.scene.add(this.corrIndicator);

    // 6. Cathode Ray Tube Phosphor Trail (1,200 points)
    this.tracePositions = new Float32Array(TRACE_POINTS * 3);
    this.traceColors = new Float32Array(TRACE_POINTS * 3);
    this.traceGeometry = new THREE.BufferGeometry();
    this.traceGeometry.setAttribute('position', new THREE.BufferAttribute(this.tracePositions, 3));
    this.traceGeometry.setAttribute('color', new THREE.BufferAttribute(this.traceColors, 3));
    this.traceMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      linewidth: 2,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
    });
    this.traceLine = new THREE.Line(this.traceGeometry, this.traceMaterial);
    this.scene.add(this.traceLine);

    // 7. Phosphor Bloom Halo Trail
    this.glowPositions = new Float32Array(TRACE_POINTS * 3);
    this.glowColors = new Float32Array(TRACE_POINTS * 3);
    this.glowGeometry = new THREE.BufferGeometry();
    this.glowGeometry.setAttribute('position', new THREE.BufferAttribute(this.glowPositions, 3));
    this.glowGeometry.setAttribute('color', new THREE.BufferAttribute(this.glowColors, 3));
    this.glowMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      linewidth: 4,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    });
    this.glowLine = new THREE.Line(this.glowGeometry, this.glowMaterial);
    this.scene.add(this.glowLine);

    // 8. Vector Scatter Particle Cloud (600 Points)
    this.scatterPositions = new Float32Array(SCATTER_POINTS * 3);
    this.scatterColors = new Float32Array(SCATTER_POINTS * 3);
    this.scatterGeometry = new THREE.BufferGeometry();
    this.scatterGeometry.setAttribute('position', new THREE.BufferAttribute(this.scatterPositions, 3));
    this.scatterGeometry.setAttribute('color', new THREE.BufferAttribute(this.scatterColors, 3));
    this.scatterMaterial = new THREE.PointsMaterial({
      size: 3.2,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
    });
    this.scatterPoints = new THREE.Points(this.scatterGeometry, this.scatterMaterial);
    this.scene.add(this.scatterPoints);
  }

  update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void {
    this.ambientTime += dtSeconds * 1.5;

    const dynStyle = settings.response;
    const profile = DYNAMIC_PROFILES[dynStyle] ?? DYNAMIC_PROFILES.punchy;
    const sens = getEffectiveSensitivity(settings.sensitivity);
    const beatTarget = audio.silent ? 0 : Math.max(
      audio.beat ? 0.72 : 0,
      goniometerDrive(audio.transient * sens * profile.transientMultiplier) * 0.44,
      goniometerDrive((audio.kick ?? 0) * sens * profile.transientMultiplier) * 0.32,
    );
    this.smoothedBeatAccent = smoothDynamic(
      this.smoothedBeatAccent,
      beatTarget,
      dtSeconds,
      dynStyle,
    );

    // Calculate targets for stereo width, subBass, mid, bass, kick, and pEnergy
    const rawWidth = audio.stereoWidth ?? 0;
    // Stereo width encodes channel correlation, not loudness; keep its geometry
    // stable as the user adjusts amplitude sensitivity.
    const targetWidth = audio.silent ? 0 : unit(rawWidth);
    const rawSubBass = audio.subBass ?? audio.bass * 0.8;
    const targetSubBass = (audio.silent ? 0 : goniometerDrive(rawSubBass * sens * profile.bassMultiplier * 0.82));
    const targetMid = (audio.silent ? 0 : goniometerDrive((audio.mid ?? 0) * sens * 0.9));
    const targetBass = (audio.silent ? 0 : goniometerDrive(audio.bass * sens * profile.bassMultiplier * 0.82));
    const targetTransient = audio.silent ? 0 : goniometerDrive(audio.transient * sens * profile.transientMultiplier * 0.72);
    const targetKick = audio.silent ? 0 : goniometerDrive((audio.kick ?? 0) * sens * profile.transientMultiplier * 0.72);
    const targetPEnergy = (audio.silent ? 0 : goniometerDrive((audio.pEnergy ?? 0) * sens * 0.85));

    this.smoothedStereoWidth = smoothDynamic(this.smoothedStereoWidth, targetWidth, dtSeconds, dynStyle);
    this.smoothedSubBass = smoothDynamic(this.smoothedSubBass, targetSubBass, dtSeconds, dynStyle);
    this.smoothedMid = smoothDynamic(this.smoothedMid, targetMid, dtSeconds, dynStyle);
    this.smoothedBass = smoothDynamic(this.smoothedBass, targetBass, dtSeconds, dynStyle);
    this.smoothedTransient = smoothDynamic(this.smoothedTransient, targetTransient, dtSeconds, dynStyle);
    this.smoothedKick = smoothDynamic(this.smoothedKick, targetKick, dtSeconds, dynStyle);
    this.smoothedPEnergy = smoothDynamic(this.smoothedPEnergy, targetPEnergy, dtSeconds, dynStyle);

    // Palette selection across all 7 supported palettes
    const palette = PALETTES[settings.palette] ?? PALETTES.aurora;

    // Tint reticle and correlation track with subtle palette luminescence
    (this.reticle.material as THREE.LineBasicMaterial).color.copy(palette.a).multiplyScalar(0.2);
    (this.corrTrack.material as THREE.LineBasicMaterial).color.copy(palette.b).multiplyScalar(0.24);

    const cx = this.centerX;
    const cy = this.centerY;
    const R = this.reticleRadius;
    const t = this.ambientTime;
    const tempColor = new THREE.Color();

    // -------------------------------------------------------------
    // Update Glowing Outer Ring Pulsing to Audio Phase & Energy
    // -------------------------------------------------------------
    const phase = audio.phase ?? 0;
    const phasePulse = (Math.sin(phase) + 1.0) * 0.5;
    const energyPulse = unit(
      this.smoothedBass * 0.1 + this.smoothedSubBass * 0.08 +
      this.smoothedPEnergy * 0.18 + this.smoothedBeatAccent * 0.4,
    );
    const ringPulseRadius = R * (1.0 + phasePulse * 0.012 + energyPulse * 0.018);

    const outerPos = this.outerRingPositions;
    const outerCols = this.outerRingColors;
    for (let i = 0; i < OUTER_RING_POINTS; i++) {
      const angle = (i / (OUTER_RING_POINTS - 1)) * Math.PI * 2;
      outerPos[i * 3] = cx + Math.cos(angle) * ringPulseRadius;
      outerPos[i * 3 + 1] = cy + Math.sin(angle) * ringPulseRadius;
      outerPos[i * 3 + 2] = 0;

      // Travelling phase-energy wave luminescence along the outer perimeter
      const wave = (Math.sin(angle * 3.0 - phase * 2.0 + t * 1.25) + 1.0) * 0.5;
      tempColor.lerpColors(palette.a, palette.b, (Math.sin(angle + t) + 1.0) * 0.5);
      const ringBrightness = 0.18 + wave * 0.2 + energyPulse * 0.16;
      outerCols[i * 3] = tempColor.r * ringBrightness;
      outerCols[i * 3 + 1] = tempColor.g * ringBrightness;
      outerCols[i * 3 + 2] = tempColor.b * ringBrightness;
    }
    this.outerRingGeometry.attributes.position.needsUpdate = true;
    this.outerRingGeometry.attributes.color.needsUpdate = true;

    // -------------------------------------------------------------
    // Update Dynamic Stereo Correlation Arc & Lissajous Phase Ellipse
    // -------------------------------------------------------------
    // Stereo width is the backend's channel-spread estimate. It controls this
    // width proxy; it is not a substitute for channel-correlated L/R samples.
    const rho = Math.max(-1.0, Math.min(1.0, 1.0 - this.smoothedStereoWidth * 2.0));
    this.correlation = rho;
    const theta = Math.asin(rho);
    this.phaseAngle = theta;

    // 1. Dynamic Lissajous Phase Ellipse centered in polar display
    // Eccentricity reflects mono (rho=1.0, vertical line), stereo (rho=0, circle),
    // and out-of-phase (rho=-1.0, horizontal line)
    const baseEllipseRadius = R * (0.42 + 0.2 * unit((audio.rms ?? 0) * 2.5));
    const rM = baseEllipseRadius * Math.sqrt(Math.max(0, (1.0 + rho) * 0.5));
    const rS = baseEllipseRadius * Math.sqrt(Math.max(0, (1.0 - rho) * 0.5));

    const elPos = this.ellipsePositions;
    const elCols = this.ellipseColors;
    for (let i = 0; i < ELLIPSE_POINTS; i++) {
      const u = (i / (ELLIPSE_POINTS - 1)) * Math.PI * 2;
      elPos[i * 3] = cx + rS * Math.sin(u);
      elPos[i * 3 + 1] = cy + rM * Math.cos(u);
      elPos[i * 3 + 2] = 0;

      tempColor.lerpColors(palette.c, palette.a, (rho + 1) * 0.5);
      const ellipseBloom = 0.34 + this.smoothedBeatAccent * 0.2;
      elCols[i * 3] = tempColor.r * ellipseBloom;
      elCols[i * 3 + 1] = tempColor.g * ellipseBloom;
      elCols[i * 3 + 2] = tempColor.b * ellipseBloom;
    }
    this.ellipseGeometry.attributes.position.needsUpdate = true;
    this.ellipseGeometry.attributes.color.needsUpdate = true;

    // 2. Correlation Meter Arc
    const corrCenterAngle = (-90 * Math.PI) / 180;
    const corrTargetAngle = corrCenterAngle + rho * ((45 * Math.PI) / 180);

    const corrPos = this.corrPositions;
    const corrCols = this.corrColors;
    const rCorr = this.corrRadius;

    for (let i = 0; i < CORR_ARC_SEGMENTS; i++) {
      const frac = i / (CORR_ARC_SEGMENTS - 1);
      const angle = corrCenterAngle + (corrTargetAngle - corrCenterAngle) * frac;
      const x = cx + Math.cos(angle) * rCorr;
      const y = cy + Math.sin(angle) * rCorr;

      corrPos[i * 3] = x;
      corrPos[i * 3 + 1] = y;
      corrPos[i * 3 + 2] = 0;

      tempColor.lerpColors(palette.c, palette.a, (rho + 1) * 0.5);

      corrCols[i * 3] = tempColor.r * 0.52;
      corrCols[i * 3 + 1] = tempColor.g * 0.52;
      corrCols[i * 3 + 2] = tempColor.b * 0.52;
    }

    // Indicator Needle at target angle
    const needleIdx = CORR_ARC_SEGMENTS;
    const nX1 = cx + Math.cos(corrTargetAngle) * (rCorr - 0.04);
    const nY1 = cy + Math.sin(corrTargetAngle) * (rCorr - 0.04);
    const nX2 = cx + Math.cos(corrTargetAngle) * (rCorr + 0.04);
    const nY2 = cy + Math.sin(corrTargetAngle) * (rCorr + 0.04);

    corrPos[needleIdx * 3] = nX1;
    corrPos[needleIdx * 3 + 1] = nY1;
    corrPos[needleIdx * 3 + 2] = 0;
    corrCols[needleIdx * 3] = palette.a.r * 0.72;
    corrCols[needleIdx * 3 + 1] = palette.a.g * 0.72;
    corrCols[needleIdx * 3 + 2] = palette.a.b * 0.72;

    corrPos[(needleIdx + 1) * 3] = nX2;
    corrPos[(needleIdx + 1) * 3 + 1] = nY2;
    corrPos[(needleIdx + 1) * 3 + 2] = 0;
    corrCols[(needleIdx + 1) * 3] = palette.a.r * 0.72;
    corrCols[(needleIdx + 1) * 3 + 1] = palette.a.g * 0.72;
    corrCols[(needleIdx + 1) * 3 + 2] = palette.a.b * 0.72;

    this.corrIndicatorGeometry.attributes.position.needsUpdate = true;
    this.corrIndicatorGeometry.attributes.color.needsUpdate = true;

    // -------------------------------------------------------------
    // Cathode Ray Tube Phosphor Trail (1,200 points)
    // -------------------------------------------------------------
    const waveform = audio.waveform;
    const waveLen = waveform ? waveform.length : 0;
    const hasWaveform = waveLen > 0 && !audio.silent;

    // Keep the plotted trace measurement-led: waveform amplitude sets M and
    // measured stereo width scales the quadrature S proxy. Music accents tint
    // and illuminate the trace without inflating its geometry.
    const traceScale = R * 0.88;

    const pos = this.tracePositions;
    const cols = this.traceColors;
    const glowPos = this.glowPositions;
    const glowCols = this.glowColors;

    // Kick transient boost activating bloom (> 1.0) on kick transients
    const bloomActivatingBoost = 0.4 + this.smoothedBeatAccent * 0.22;

    for (let i = 0; i < TRACE_POINTS; i++) {
      const u = (i / (TRACE_POINTS - 1)) * Math.PI * 2;
      let midSample = 0;
      let sideSample = 0;

      if (waveform && hasWaveform) {
        // Continuous spline-like interpolation over incoming audio waveform
        const param = (i / (TRACE_POINTS - 1)) * (waveLen - 1);
        const idx0 = Math.floor(param);
        const frac = param - idx0;
        const idx1 = Math.min(idx0 + 1, waveLen - 1);
        const s0 = waveform[idx0] ?? 0;
        const s1 = waveform[idx1] ?? 0;
        midSample = s0 * (1 - frac) + s1 * frac;

        // Quadrature / orthogonal phase differential for instantaneous stereo displacement
        const offset = Math.max(1, Math.floor(waveLen / 8));
        const qIdx0 = (idx0 + offset) % waveLen;
        const qIdx1 = (qIdx0 + 1) % waveLen;
        const qs0 = waveform[qIdx0] ?? 0;
        const qs1 = waveform[qIdx1] ?? 0;
        const quadSample = qs0 * (1 - frac) + qs1 * frac;

        sideSample = quadSample - midSample * 0.15;
      } else {
        // Gentle ambient harmonic motion during silence or absent waveform
        const ambAmp = audio.silent ? 0.12 : 0.28;
        midSample = Math.sin(u * 2.0 + t * 1.3) * ambAmp;
        sideSample = Math.cos(u * 3.0 + t * 0.9) * ambAmp;
      }

      // Coordinate mapping into M/S display space. The phase-offset S trace is
      // a visual proxy because RenderAudio currently exposes mono waveform plus
      // scalar stereo width rather than synchronized left/right sample arrays.
      let m = midSample * traceScale;
      let s = sideSample * traceScale * this.smoothedStereoWidth;

      // Soft CRT radial deflection limiter inside the reticle boundary
      const radiusDist = Math.sqrt(m * m + s * s);
      const maxR = R * 0.96;
      if (radiusDist > maxR) {
        const factor = (maxR / radiusDist) * Math.tanh(radiusDist / maxR);
        m *= factor;
        s *= factor;
      }

      const x = cx + s;
      const y = cy + m;

      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = 0;

      // Soft glow trail with subtle chromatic aberration displacement
      glowPos[i * 3] = cx + s * 1.025;
      glowPos[i * 3 + 1] = cy + m * 1.025;
      glowPos[i * 3 + 2] = 0;

      // Logarithmic alpha decay across trace history
      // h = 0 is oldest phosphor tail, h = 1 is newest beam head
      const h = i / (TRACE_POINTS - 1);
      const phosphorDecay = 0.2 + 0.58 * (Math.log(1.0 + 9.0 * h) / Math.LN10);

      // Color mapping: multi-stop palette interpolation + bloom-activating boost
      const colorRatio = (i / TRACE_POINTS + t * 0.025) % 1.0;
      if (colorRatio < 0.5) {
        tempColor.lerpColors(palette.a, palette.b, colorRatio * 2.0);
      } else {
        tempColor.lerpColors(palette.b, palette.c, (colorRatio - 0.5) * 2.0);
      }
      const beatTint = unit(this.smoothedBeatAccent * h * 0.48);
      tempColor.lerp(palette.a, beatTint);
      cols[i * 3] = tempColor.r * phosphorDecay * bloomActivatingBoost;
      cols[i * 3 + 1] = tempColor.g * phosphorDecay * bloomActivatingBoost;
      cols[i * 3 + 2] = tempColor.b * phosphorDecay * bloomActivatingBoost;

      glowCols[i * 3] = tempColor.r * phosphorDecay * 0.12;
      glowCols[i * 3 + 1] = tempColor.g * phosphorDecay * 0.12;
      glowCols[i * 3 + 2] = tempColor.b * phosphorDecay * 0.12;
    }

    this.traceGeometry.attributes.position.needsUpdate = true;
    this.traceGeometry.attributes.color.needsUpdate = true;
    this.glowGeometry.attributes.position.needsUpdate = true;
    this.glowGeometry.attributes.color.needsUpdate = true;

    // -------------------------------------------------------------
    // Particle Cloud (600 points drifting outward on high stereo width and P energy)
    // -------------------------------------------------------------
    const scatterPos = this.scatterPositions;
    const scatterCols = this.scatterColors;
    const pEnergy = audio.silent ? 0 : goniometerDrive((audio.pEnergy ?? 0) * sens);
    const outwardDrift = this.smoothedStereoWidth * 0.35 + pEnergy * 0.45 + this.smoothedPEnergy * 0.2;

    for (let k = 0; k < SCATTER_POINTS; k++) {
      const traceIdx = Math.floor((k / SCATTER_POINTS) * (TRACE_POINTS - 1));
      const tx = pos[traceIdx * 3] ?? cx;
      const ty = pos[traceIdx * 3 + 1] ?? cy;

      const dx = tx - cx;
      const dy = ty - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const nx = dist > 0.001 ? dx / dist : Math.cos((k / SCATTER_POINTS) * Math.PI * 2);
      const ny = dist > 0.001 ? dy / dist : Math.sin((k / SCATTER_POINTS) * Math.PI * 2);

      // Golden spiral phase dispersion for realistic outward cloud expansion
      const goldenPhase = (k * 137.5 * Math.PI) / 180;
      const driftDist = outwardDrift * (0.04 + 0.16 * ((Math.sin(goldenPhase + t * 3.5) + 1.0) * 0.5));
      const swirl = this.smoothedStereoWidth * 0.06 * Math.cos(goldenPhase + t * 2.0);

      let px = tx + nx * driftDist - ny * swirl;
      let py = ty + ny * driftDist + nx * swirl;

      // Soft circular boundary limiter
      const pDist = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
      if (pDist > R * 0.98) {
        const scale = (R * 0.98) / pDist;
        px = cx + (px - cx) * scale;
        py = cy + (py - cy) * scale;
      }

      scatterPos[k * 3] = px;
      scatterPos[k * 3 + 1] = py;
      scatterPos[k * 3 + 2] = 0;

      const colorRatio = (k / SCATTER_POINTS + t * 0.08) % 1.0;
      if (colorRatio < 0.5) {
        tempColor.lerpColors(palette.a, palette.b, colorRatio * 2.0);
      } else {
        tempColor.lerpColors(palette.b, palette.c, (colorRatio - 0.5) * 2.0);
      }

      const pBrightness = 0.24 + unit(outwardDrift) * 0.12 + this.smoothedBeatAccent * 0.1;
      scatterCols[k * 3] = tempColor.r * pBrightness;
      scatterCols[k * 3 + 1] = tempColor.g * pBrightness;
      scatterCols[k * 3 + 2] = tempColor.b * pBrightness;
    }

    this.scatterGeometry.attributes.position.needsUpdate = true;
    this.scatterGeometry.attributes.color.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number, _pixelRatio: number): void {
    const aspect = width / Math.max(height, 1);
    this.camera.left = -aspect;
    this.camera.right = aspect;
    this.camera.top = 1.0;
    this.camera.bottom = -1.0;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.reticleGeometry.dispose();
    this.reticleMaterial.dispose();

    this.outerRingGeometry.dispose();
    this.outerRingMaterial.dispose();

    this.ellipseGeometry.dispose();
    this.ellipseMaterial.dispose();

    this.corrTrackGeometry.dispose();
    this.corrTrackMaterial.dispose();
    this.corrIndicatorGeometry.dispose();
    this.corrIndicatorMaterial.dispose();

    this.traceGeometry.dispose();
    this.traceMaterial.dispose();
    this.glowGeometry.dispose();
    this.glowMaterial.dispose();

    this.scatterGeometry.dispose();
    this.scatterMaterial.dispose();

    this.scene.remove(this.reticle);
    this.scene.remove(this.outerRing);
    this.scene.remove(this.ellipseLine);
    this.scene.remove(this.corrTrack);
    this.scene.remove(this.corrIndicator);
    this.scene.remove(this.traceLine);
    this.scene.remove(this.glowLine);
    this.scene.remove(this.scatterPoints);
  }
}
