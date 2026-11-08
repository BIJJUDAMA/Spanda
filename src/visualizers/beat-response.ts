import { DYNAMIC_PROFILES, getEffectiveSensitivity } from './dynamics';
import type { RenderAudio, VisualSettings } from './types';

const level = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, Math.min(1, value ?? 0)) : 0;

/** Visual accents follow reported beats/phase and measured onsets, never a free-running BPM timer. */
export class SceneBeatResponse {
  pulse = 0;
  age = 100;
  triggered = false;
  private envelope = 0;
  private previousBeat = false;
  private previousPhase: number | null = null;
  private previousKick = 0;
  private previousTransient = 0;
  private previousBass = 0;
  private sinceOnset = 100;

  update(dt: number, audio: RenderAudio, settings: VisualSettings) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(.1, dt)) : 0;
    const profile = DYNAMIC_PROFILES[settings.response] ?? DYNAMIC_PROFILES.punchy;
    const kick = audio.silent ? 0 : level(audio.kick);
    const transient = audio.silent ? 0 : level(audio.transient);
    const bass = audio.silent ? 0 : level(audio.bass);
    const beat = !audio.silent && Boolean(audio.beat);
    const phase = !audio.silent && level(audio.confidence) >= .55 && Number.isFinite(audio.phase) ? audio.phase! : null;
    const wrapped = phase !== null && (this.previousPhase === null ? phase < .18 : this.previousPhase > 4.5 && phase < 1.5);
    const kickRise = Math.max(0, kick - this.previousKick);
    const transientRise = Math.max(0, transient - this.previousTransient);
    const bassRise = Math.max(0, bass - this.previousBass);
    const onset = (beat && !this.previousBeat) || wrapped || kickRise > .12 || transientRise > .15 || bassRise > .16;
    this.sinceOnset += step;
    this.age = Math.min(100, this.age + step);
    this.envelope *= Math.exp(-step / Math.max(.08, profile.releaseTau));
    this.triggered = !audio.silent && onset && this.sinceOnset >= .1;
    if (this.triggered) {
      const reported = beat || wrapped ? .75 + .25 * Math.max(kick, bass, transient) : 0;
      const strength = Math.max(reported, kickRise * 2.2, transientRise * 1.8, bassRise * 1.6);
      this.envelope = Math.max(this.envelope, Math.min(1, strength * getEffectiveSensitivity(settings.sensitivity) * profile.beatIntensity));
      this.sinceOnset = 0; this.age = 0;
    }
    const tau = this.envelope > this.pulse ? profile.attackTau : Math.min(.08, profile.releaseTau);
    this.pulse += (this.envelope - this.pulse) * (1 - Math.exp(-step / Math.max(.001, tau)));
    if (this.pulse < .0001) this.pulse = 0;
    this.previousBeat = beat; this.previousPhase = phase;
    this.previousKick = kick; this.previousTransient = transient; this.previousBass = bass;
    return this;
  }
}
