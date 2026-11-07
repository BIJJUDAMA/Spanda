import type { RenderAudio, ResponseStyle } from './types';

/** Maps the user-facing gain onto a gentler visual baseline. 1× is tuned below
 * the old raw 1× level so typical system audio stays vivid without hitting
 * extreme pulses and bloom.
 */
export function getEffectiveSensitivity(userSensitivity: number = 1): number {
  const bounded = Number.isFinite(userSensitivity) ? Math.max(0.25, Math.min(2, userSensitivity)) : 1;
  return bounded * 0.62;
}

export interface DynamicProfile {
  name: string;
  attackTau: number;
  releaseTau: number;
  beatIntensity: number;   // Multiplier applied to beat pulses
  bassMultiplier: number;
  transientSens: number;
  transientMultiplier: number;
  springBounciness: number;
}

export const DYNAMIC_PROFILES: Record<ResponseStyle, DynamicProfile> = {
  punchy: {
    name: 'Punchy',
    attackTau: 0.015,
    releaseTau: 0.160,
    beatIntensity: 1.8,
    bassMultiplier: 1.4,
    transientSens: 1.3,
    transientMultiplier: 1.3,
    springBounciness: 0.0,
  },
  smooth: {
    name: 'Smooth',
    attackTau: 0.120,
    releaseTau: 0.550,
    beatIntensity: 0.9,
    bassMultiplier: 1.0,
    transientSens: 0.7,
    transientMultiplier: 0.7,
    springBounciness: 0.0,
  },
  hyper: {
    name: 'Hyper',
    attackTau: 0.004,
    releaseTau: 0.075,
    beatIntensity: 2.6,
    bassMultiplier: 1.9,
    transientSens: 2.0,
    transientMultiplier: 2.0,
    springBounciness: 0.1,
  },
  liquid: {
    name: 'Liquid',
    attackTau: 0.040,
    releaseTau: 0.380,
    beatIntensity: 1.3,
    bassMultiplier: 1.25,
    transientSens: 1.0,
    transientMultiplier: 1.0,
    springBounciness: 0.0,
  },
  bouncy: {
    name: 'Bouncy',
    attackTau: 0.010,
    releaseTau: 0.220,
    beatIntensity: 2.2,
    bassMultiplier: 1.6,
    transientSens: 1.6,
    transientMultiplier: 1.6,
    springBounciness: 0.65, // Strong elastic rebound oscillation
  },
};

export interface BeatProcessResult {
  bass: number;
  mid: number;
  treble: number;
  beat: number;
  pulseScale: number;
  subBass: number;
  kick: number;
  pEnergy: number;
  hEnergy: number;
  centroid: number;
  flatness: number;
  stereoWidth: number;
  dominantChroma: number;
  chroma: Float32Array;
  phase: number;
  confidence: number;
  isPredictiveBeat: boolean;
}

/**
 * Stateful beat follower that tracks musical rhythm, bass onsets, and spring bounce,
 * synchronized with predictive Phase-Locked Loop (PLL) when confidence is sufficient.
 */
export class BeatFollower {
  public smoothedBass: number = 0;
  public smoothedMid: number = 0;
  public smoothedTreble: number = 0;
  public beatEnergy: number = 0; // Decaying musical beat envelope [0, 1]
  public springPhase: number = 0; // For bouncy spring oscillations

  // Musical intelligence smoothed features
  public smoothedSubBass: number = 0;
  public smoothedKick: number = 0;
  public smoothedPEnergy: number = 0;
  public smoothedHEnergy: number = 0;
  public smoothedCentroid: number = 0;
  public smoothedFlatness: number = 0;
  public smoothedStereoWidth: number = 0;
  public dominantChroma: number = 0; // 0..11
  public chromaDistribution: Float32Array = new Float32Array(12);
  public pllPhase: number = 0;
  public pllConfidence: number = 0;
  public isPredictiveBeat: boolean = false;

  private avgBass: number = 0.15;
  private avgKick: number = 0.10;
  private lastBeatTime: number = -1.0;
  private prevPllPhase: number = 0;

  public process(
    rawBassOrAudio: number | RenderAudio,
    rawMidOrDt: number = 0,
    rawTrebleOrNowSec: number = 0,
    rawTransientOrStyle: number | ResponseStyle = 0,
    dtOrSettings: number = 0.016,
    nowSecArg: number = 0,
    styleArg: ResponseStyle = 'punchy',
    extraAudio?: Partial<RenderAudio>
  ): BeatProcessResult {
    let rawBass: number;
    let rawMid: number;
    let rawTreble: number;
    let rawTransient: number;
    let dt: number;
    let nowSec: number;
    let style: ResponseStyle;

    let rawSubBass: number;
    let rawKick: number;
    let rawPEnergy: number;
    let rawHEnergy: number;
    let rawCentroid: number;
    let rawFlatness: number;
    let rawStereoWidth: number;
    let rawChroma: number[] | Float32Array | undefined;
    let phase: number | undefined;
    let confidence: number;
    let isBeatFlag: boolean;

    if (typeof rawBassOrAudio === 'object' && rawBassOrAudio !== null) {
      const audio = rawBassOrAudio;
      dt = typeof rawMidOrDt === 'number' && rawMidOrDt > 0 ? rawMidOrDt : 0.016;
      nowSec = typeof rawTrebleOrNowSec === 'number' ? rawTrebleOrNowSec : 0;
      style = (typeof rawTransientOrStyle === 'string' ? rawTransientOrStyle : 'punchy') as ResponseStyle;

      const silent = audio.silent;
      rawBass = silent ? 0 : (audio.bass ?? 0);
      rawMid = silent ? 0 : (audio.mid ?? 0);
      rawTreble = silent ? 0 : (audio.treble ?? 0);
      rawTransient = silent ? 0 : (audio.transient ?? 0);

      rawSubBass = silent ? 0 : (audio.subBass ?? rawBass);
      rawKick = silent ? 0 : (audio.kick ?? rawBass);
      rawPEnergy = silent ? 0 : (audio.pEnergy ?? 0);
      rawHEnergy = silent ? 0 : (audio.hEnergy ?? 0);
      rawCentroid = silent ? 0 : (audio.centroid ?? 0);
      rawFlatness = silent ? 0 : (audio.flatness ?? 0);
      rawStereoWidth = silent ? 0 : (audio.stereoWidth ?? 0);
      rawChroma = silent ? undefined : audio.chroma;
      phase = audio.phase;
      confidence = silent ? 0 : (audio.confidence ?? 0);
      isBeatFlag = silent ? false : Boolean(audio.beat);
    } else {
      rawBass = rawBassOrAudio;
      rawMid = rawMidOrDt;
      rawTreble = rawTrebleOrNowSec;
      rawTransient = typeof rawTransientOrStyle === 'number' ? rawTransientOrStyle : 0;
      dt = dtOrSettings > 0 ? dtOrSettings : 0.016;
      nowSec = nowSecArg;
      style = (typeof styleArg === 'string' ? styleArg : 'punchy') as ResponseStyle;

      rawSubBass = extraAudio?.subBass ?? rawBass;
      rawKick = extraAudio?.kick ?? rawBass;
      rawPEnergy = extraAudio?.pEnergy ?? 0;
      rawHEnergy = extraAudio?.hEnergy ?? 0;
      rawCentroid = extraAudio?.centroid ?? 0;
      rawFlatness = extraAudio?.flatness ?? 0;
      rawStereoWidth = extraAudio?.stereoWidth ?? 0;
      rawChroma = extraAudio?.chroma;
      phase = extraAudio?.phase;
      confidence = extraAudio?.confidence ?? 0;
      isBeatFlag = Boolean(extraAudio?.beat);
    }

    const profile = DYNAMIC_PROFILES[style] ?? DYNAMIC_PROFILES.punchy;

    // 1. Adaptive Onset & Energy Smoothing
    const isBassRising = rawBass > this.smoothedBass;
    const bassTau = isBassRising ? profile.attackTau : profile.releaseTau;
    const bassAlpha = 1.0 - Math.exp(-dt / Math.max(0.001, bassTau));
    this.smoothedBass += bassAlpha * (rawBass * profile.bassMultiplier - this.smoothedBass);

    // Smooth sub-bass and kick
    const isSubRising = rawSubBass > this.smoothedSubBass;
    const subTau = isSubRising ? profile.attackTau : profile.releaseTau;
    this.smoothedSubBass += (1.0 - Math.exp(-dt / Math.max(0.001, subTau))) * (rawSubBass * profile.bassMultiplier - this.smoothedSubBass);

    const isKickRising = rawKick > this.smoothedKick;
    const kickTau = isKickRising ? profile.attackTau * 0.8 : profile.releaseTau * 0.9;
    this.smoothedKick += (1.0 - Math.exp(-dt / Math.max(0.001, kickTau))) * (rawKick * profile.bassMultiplier - this.smoothedKick);

    // Smooth mid and treble
    const isMidRising = rawMid > this.smoothedMid;
    const midTau = isMidRising ? 0.025 : 0.200;
    this.smoothedMid += (1.0 - Math.exp(-dt / midTau)) * (rawMid - this.smoothedMid);

    const isTrebleRising = rawTreble > this.smoothedTreble;
    const trebleTau = isTrebleRising ? 0.015 : 0.080;
    this.smoothedTreble += (1.0 - Math.exp(-dt / trebleTau)) * (rawTreble - this.smoothedTreble);

    // Smooth HPSS percussive & harmonic components
    const isPRising = rawPEnergy > this.smoothedPEnergy;
    const pTau = isPRising ? 0.008 : 0.100;
    this.smoothedPEnergy += (1.0 - Math.exp(-dt / pTau)) * (rawPEnergy - this.smoothedPEnergy);
    this.smoothedHEnergy += (1.0 - Math.exp(-dt / 0.120)) * (rawHEnergy - this.smoothedHEnergy);

    // Smooth spectral features
    this.smoothedCentroid += (1.0 - Math.exp(-dt / 0.060)) * (rawCentroid - this.smoothedCentroid);
    this.smoothedFlatness += (1.0 - Math.exp(-dt / 0.060)) * (rawFlatness - this.smoothedFlatness);
    this.smoothedStereoWidth += (1.0 - Math.exp(-dt / 0.080)) * (rawStereoWidth - this.smoothedStereoWidth);

    // Smooth chroma pitch classes & extract dominant pitch
    if (rawChroma && rawChroma.length >= 12) {
      let maxVal = -1;
      let maxIdx = 0;
      for (let i = 0; i < 12; i++) {
        const val = rawChroma[i] ?? 0;
        this.chromaDistribution[i] += (1.0 - Math.exp(-dt / 0.080)) * (val - this.chromaDistribution[i]);
        if (this.chromaDistribution[i] > maxVal) {
          maxVal = this.chromaDistribution[i];
          maxIdx = i;
        }
      }
      this.dominantChroma = maxIdx;
    }

    // Dynamic moving average baseline
    this.avgBass += (1.0 - Math.exp(-dt / 0.8)) * (rawBass - this.avgBass);
    this.avgKick += (1.0 - Math.exp(-dt / 0.8)) * (rawKick - this.avgKick);

    const bassFlux = Math.max(0, rawBass - this.avgBass);
    const kickFlux = Math.max(0, rawKick - this.avgKick);

    this.pllConfidence = confidence;
    if (phase !== undefined) {
      this.pllPhase = phase;
    }

    // 2. Beat Detection & PLL Phase Synchronization
    // If confidence > 0.35 and phase !== undefined, synchronize beat pulse with PLL phase;
    // if low confidence, fallback to kick flux / beat.
    const isPllLocked = confidence > 0.35 && phase !== undefined;

    const hasOnset =
      (rawTransient > 0.25 || (kickFlux > 0.10 && rawKick > 0.25) || (bassFlux > 0.12 && rawBass > 0.3) || rawPEnergy > 0.35 || isBeatFlag) &&
      nowSec - this.lastBeatTime > 0.11;

    const kickIntensity = Math.min(
      1.0,
      (kickFlux * 2.8 + bassFlux * 1.5 + rawTransient * 1.5 + rawPEnergy * 1.2) * profile.transientSens
    );

    if (isPllLocked) {
      const p = phase!;
      // Detect PLL phase cycle wrap (downbeat transition)
      const wrapped = (this.prevPllPhase > 4.5 && p < 1.5) || (p < this.prevPllPhase - 1.0);
      this.isPredictiveBeat = wrapped;

      if (wrapped && profile.springBounciness > 0) {
        this.springPhase = 0;
      }

      // Continuous phase-locked pulse envelope: maximum at phase = 0 (downbeat)
      const cosPhase = Math.max(0, Math.cos(p));
      const pllExp = style === 'hyper' ? 10.0 : style === 'punchy' ? 6.0 : style === 'bouncy' ? 5.0 : style === 'liquid' ? 4.0 : 3.0;
      const pllPulse = Math.pow(cosPhase, pllExp);

      // Weight blend between pure kick onset and PLL phase pulse
      const pllWeight = Math.min(1.0, (confidence - 0.35) / 0.35);
      const audioDrive = Math.max(0.35, this.smoothedKick, this.smoothedPEnergy, this.smoothedBass);
      const targetPllBeat = pllPulse * audioDrive;

      if (hasOnset) {
        this.lastBeatTime = nowSec;
        this.beatEnergy = Math.max(this.beatEnergy, kickIntensity);
      } else {
        const decayRate = style === 'hyper' ? 14.0 : style === 'punchy' ? 7.5 : style === 'bouncy' ? 6.0 : style === 'liquid' ? 5.0 : 3.5;
        this.beatEnergy = Math.max(0, this.beatEnergy - this.beatEnergy * decayRate * dt);
      }

      // Synchronize beatEnergy with PLL phase pulse
      this.beatEnergy = (1.0 - pllWeight) * this.beatEnergy + pllWeight * Math.max(this.beatEnergy, targetPllBeat);
      this.prevPllPhase = p;
    } else {
      // Low confidence fallback: direct kick flux and transient energy
      this.isPredictiveBeat = false;
      this.prevPllPhase = phase ?? 0;

      if (hasOnset) {
        this.lastBeatTime = nowSec;
        this.beatEnergy = Math.max(this.beatEnergy, kickIntensity);
        if (profile.springBounciness > 0) {
          this.springPhase = 0;
        }
      } else {
        const decayRate = style === 'hyper' ? 14.0 : style === 'punchy' ? 7.5 : style === 'bouncy' ? 6.0 : style === 'liquid' ? 5.0 : 3.5;
        this.beatEnergy = Math.max(0, this.beatEnergy - this.beatEnergy * decayRate * dt);
      }
    }

    // 3. Calculate Visual Pulse Multiplier
    let pulse = this.beatEnergy * profile.beatIntensity;

    // Apply Elastic Spring Bounce for 'bouncy'
    if (profile.springBounciness > 0 && this.beatEnergy > 0.05) {
      this.springPhase += dt * 18.0;
      const springBounce = Math.sin(this.springPhase) * Math.exp(-this.springPhase * 0.25) * profile.springBounciness;
      pulse = Math.max(0, pulse * (1.0 + springBounce));
    }

    return {
      bass: this.smoothedBass,
      mid: this.smoothedMid,
      treble: this.smoothedTreble,
      beat: this.beatEnergy,
      pulseScale: 1.0 + pulse,
      subBass: this.smoothedSubBass,
      kick: this.smoothedKick,
      pEnergy: this.smoothedPEnergy,
      hEnergy: this.smoothedHEnergy,
      centroid: this.smoothedCentroid,
      flatness: this.smoothedFlatness,
      stereoWidth: this.smoothedStereoWidth,
      dominantChroma: this.dominantChroma,
      chroma: this.chromaDistribution,
      phase: this.pllPhase,
      confidence: this.pllConfidence,
      isPredictiveBeat: this.isPredictiveBeat,
    };
  }
}

/**
 * Standalone scalar smoother compatible with existing tests.
 */
export function smoothDynamic(
  current: number,
  target: number,
  dt: number,
  style: ResponseStyle = 'punchy'
): number {
  if (dt <= 0) return current;
  const profile = DYNAMIC_PROFILES[style] ?? DYNAMIC_PROFILES.punchy;
  const isRising = target > current;
  const tau = isRising ? profile.attackTau : profile.releaseTau;
  const alpha = 1.0 - Math.exp(-dt / Math.max(0.001, tau));

  let next = current + alpha * (target - current);

  if (style === 'bouncy' && isRising && target > 0.3) {
    const overshoot = Math.sin(Math.min(Math.PI, dt * 18.0)) * (target - current) * 0.25;
    next = Math.min(2.0, next + overshoot);
  }

  return Math.abs(next) < 1e-4 ? 0 : next;
}
