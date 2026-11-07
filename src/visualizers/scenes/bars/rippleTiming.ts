import type { RenderAudio } from '../../types';

/** Launch once per measured onset; sustained band energy is not an onset. */
export class RippleTiming {
  private previousBeat = false;
  private previousPhase: number | undefined;
  private previousTransient = 0;
  private kickBaseline = 0;
  private cooldown = 0;

  update(audio: RenderAudio, dt: number): boolean {
    this.cooldown = Math.max(0, this.cooldown - Math.max(0, dt));
    const locked = (audio.confidence ?? 0) >= 0.5 && Number.isFinite(audio.phase);
    const phase = locked ? audio.phase : undefined;
    const wrap = phase !== undefined && this.previousPhase !== undefined &&
      this.previousPhase > 4.5 && phase < 1.5;
    const beatEdge = Boolean(audio.beat) && !this.previousBeat;
    const kick = Math.max(0, audio.kick ?? audio.bass);
    const transient = Math.max(0, audio.transient);
    const onset = !locked && (
      (kick > 0.18 && kick - this.kickBaseline > 0.1 && transient - this.previousTransient > 0.04) ||
      (transient > 0.28 && transient - this.previousTransient > 0.12)
    );
    this.kickBaseline += (kick - this.kickBaseline) * (1 - Math.exp(-Math.max(0, dt) / 0.18));
    this.previousBeat = Boolean(audio.beat);
    this.previousPhase = phase;
    this.previousTransient = transient;
    if (audio.silent) {
      this.previousPhase = undefined;
      this.kickBaseline = 0;
      this.previousTransient = 0;
      return false;
    }
    if (this.cooldown > 0 || !(beatEdge || wrap || onset)) return false;
    const period = (audio.bpm ?? 0) >= 45 ? 60 / audio.bpm! : 0.5;
    this.cooldown = Math.max(0.16, Math.min(0.3, period * 0.45));
    return true;
  }
}
