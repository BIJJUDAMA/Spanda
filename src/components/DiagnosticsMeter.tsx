import { useEffect, useRef, type ReactNode } from 'react';
import type { AudioView, UnifiedAnalysisFrame } from '../audio/types';
import { defaultAnalysisFrame } from '../audio/types';

export interface DiagnosticsMeterProps {
  frame?: UnifiedAnalysisFrame;
  source?: 'wasapi' | 'idle';
  view?: AudioView;
  isVisible: boolean;
  children?: ReactNode;
  mode?: 'full' | 'diagnostics' | 'player';
  hidden?: boolean;
}

function amplitudeDb(value: number): number {
  return Number.isFinite(value) && value > 0 ? 20 * Math.log10(value) : -Infinity;
}

function formatDb(value: number): string {
  const db = amplitudeDb(value);
  return Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : '−∞ dBFS';
}

export function DiagnosticsMeter({
  frame,
  view,
  isVisible,
  children,
  mode = 'full',
  hidden = false,
}: DiagnosticsMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const activeFrame = frame ?? view?.analysis ?? defaultAnalysisFrame;
  const formatText = view?.sampleRate
    ? `${view.sampleRate} Hz / ${view.channels} channels`
    : 'Waiting for audio packets';

  const rmsVal = activeFrame.rms !== undefined ? activeFrame.rms : (view?.rms ?? 0);
  const peakVal = activeFrame.peak !== undefined ? activeFrame.peak : (view?.peak ?? 0);

  const isSilent =
    (view !== undefined ? view.silent : undefined) ??
    (rmsVal < 0.001);
  const signalText = isSilent ? 'Silence' : 'Audio detected';

  useEffect(() => {
    if (!isVisible) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const midY = height / 2;

    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(0, 0, width, height);

    // Subtle horizontal center grid line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    const waveform = activeFrame.waveform ?? [];
    const isWaveformSilent =
      waveform.length === 0 ||
      waveform.every((v) => Math.abs(v) < 0.001) ||
      isSilent;

    // Waveform line styling: green/cyan glow
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(34, 197, 94, 0.65)';
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    if (isWaveformSilent) {
      ctx.moveTo(0, midY);
      ctx.lineTo(width, midY);
    } else {
      const len = waveform.length;
      const step = width / Math.max(1, len - 1);
      for (let i = 0; i < len; i++) {
        const x = i * step;
        const value = waveform[i] ?? 0;
        const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
        const y = midY - sample * (midY - 4);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
    }

    ctx.stroke();
    ctx.shadowBlur = 0;
  }, [activeFrame, isVisible, isSilent]);

  const melBands =
    activeFrame.mel && activeFrame.mel.length >= 64
      ? activeFrame.mel.slice(0, 64)
      : Array.from({ length: 64 }, (_, i) => activeFrame.mel?.[i] ?? 0);

  return (
    <section
      className="diagnostics-meter-container diagnostics-sidebar"
      data-mode={mode}
      hidden={hidden}
      role={mode === 'full' ? undefined : 'tabpanel'}
      aria-labelledby={mode === 'full' ? undefined : mode === 'player' ? 'hud-tab-spotify' : 'hud-tab-diagnostics'}
      data-testid="diagnostics-meter"
      id="diagnostics-panel"
      aria-label="Real-time Audio Diagnostics"
    >
      <header className="diagnostics-meter-header" hidden={mode === 'player'}>
        <h2 className="diagnostics-meter-title">Diagnostics</h2>
      </header>

      <div className="diagnostics-visuals-row" hidden={mode === 'player'}>
        <div className="diagnostics-waveform-wrap">
          <canvas
            ref={canvasRef}
            width={240}
            height={48}
            className="diagnostics-waveform-canvas"
            data-testid="diagnostics-waveform"
            aria-label="Waveform oscilloscope"
          />
        </div>

        <div className="diagnostics-spectrum">
        <div
          className="diagnostics-bands-grid"
          data-testid="diagnostics-bands"
          role="img"
          aria-label="64-band equalizer LED bars"
        >
          {melBands.map((val, idx) => {
            const clamped = Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0;
            const heightPercent = clamped * 100;
            return (
              <div
                key={idx}
                className="diagnostics-bar"
                data-testid={`diagnostics-bar-${idx}`}
                style={{ height: `${heightPercent}%` }}
                title={`Band ${idx + 1}: ${(clamped * 100).toFixed(0)}%`}
              />
            );
          })}
        </div>
        <div className="diagnostics-frequency-labels" aria-hidden="true"><span>Bass</span><span>Mids</span><span>Treble</span></div>
        </div>
      </div>

      <div className="diagnostics-channel-levels" role="group" aria-label="Channel peak levels" hidden={mode === 'player'}>
        {([['L', 'Left', activeFrame.leftPeak], ['R', 'Right', activeFrame.rightPeak]] as const).map(([short, name, peak]) => {
          const db = Math.max(-60, Math.min(0, amplitudeDb(peak)));
          const reading = formatDb(peak);
          return <div className="diagnostics-channel" key={short}>
            <span className="diagnostics-channel-label" aria-hidden="true">{short}</span>
            <div className="diagnostics-level-track" role="meter" aria-label={`${name} channel peak`} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={db} aria-valuetext={reading}>
              <div className="diagnostics-level-fill" style={{ width: `${((db + 60) / 60) * 100}%` }} />
            </div>
            <span className="diagnostics-channel-value" aria-hidden="true">{reading}</span>
          </div>;
        })}
        <div className="diagnostics-level-scale" aria-hidden="true"><span>−60</span><span>−30</span><span>0 dBFS</span></div>
      </div>

      <div className="diagnostics-telemetry-grid" role="group" aria-label="Audio telemetry" hidden={mode === 'player'}>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">Format</span>
          <span className="telemetry-value stat-value" data-testid="stat-format">
            {formatText}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">RMS</span>
          <span className="telemetry-value stat-value" aria-label="RMS" data-testid="stat-rms">
            {formatDb(rmsVal)}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">Peak</span>
          <span className="telemetry-value stat-value" aria-label="Peak" data-testid="stat-peak">
            {formatDb(peakVal)}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">Signal</span>
          <span className="telemetry-value stat-value" aria-label="Signal" data-testid="stat-signal">
            {signalText}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">BPM</span>
          <span className="telemetry-value stat-value" data-testid="stat-bpm">
            {activeFrame.bpm > 0 ? Math.round(activeFrame.bpm) : '--'}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">Tempo confidence</span>
          <span className="telemetry-value stat-value" data-testid="stat-confidence">
            {activeFrame.confidence !== undefined
              ? `${Math.round(activeFrame.confidence * 100)}%`
              : '--'}
          </span>
        </div>
      </div>

      {children && <div className="diagnostics-player-slot" hidden={mode === 'diagnostics'}>{children}</div>}

      <footer className="diagnostics-shortcuts" role="group" aria-label="Keyboard shortcuts" hidden={mode === 'player'}>
        <h3 className="diagnostics-shortcuts-title">Shortcuts</h3>
        <dl className="diagnostics-shortcuts-list">
          <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Change scene</dd></div>
          <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Change color</dd></div>
          <div><dt><kbd>H</kbd></dt><dd>Hide Controls</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Start / stop audio</dd></div>
          <div><dt><kbd>F</kbd> <kbd>F11</kbd></dt><dd>Toggle fullscreen</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Exit fullscreen</dd></div>
        </dl>
      </footer>
    </section>
  );
}
