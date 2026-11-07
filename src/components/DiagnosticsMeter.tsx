import { useEffect, useRef, useState } from 'react';
import type { AudioView, UnifiedAnalysisFrame } from '../audio/types';
import { defaultAnalysisFrame } from '../audio/types';

export interface DiagnosticsMeterProps {
  frame?: UnifiedAnalysisFrame;
  source?: 'wasapi' | 'idle';
  view?: AudioView;
  isVisible: boolean;
  onToggle: () => void;
}

export function DiagnosticsMeter({
  frame,
  source,
  view,
  isVisible,
  onToggle,
}: DiagnosticsMeterProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [shouldRender, setShouldRender] = useState(isVisible);
  const [isClosing, setIsClosing] = useState(false);

  // Smooth open & close animation lifecycle
  useEffect(() => {
    let timeoutId: number;
    if (isVisible) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      timeoutId = window.setTimeout(() => {
        setShouldRender(false);
        setIsClosing(false);
      }, 220); // Keep the panel mounted through its transform transition.
    }
    return () => clearTimeout(timeoutId);
  }, [isVisible, shouldRender]);

  const activeFrame = frame ?? view?.analysis ?? defaultAnalysisFrame;
  const sourceType = source ?? view?.source ?? 'idle';
  const activeState = view?.state ?? (sourceType === 'wasapi' ? 'running' : 'idle');
  const formatText = view?.sampleRate
    ? `${view.sampleRate} Hz / ${view.channels} channels`
    : 'Waiting for audio packets';

  const rmsVal = activeFrame.rms !== undefined ? activeFrame.rms : (view?.rms ?? 0);
  const peakVal = activeFrame.peak !== undefined ? activeFrame.peak : (view?.peak ?? 0);

  const isSilent =
    (view !== undefined ? view.silent : undefined) ??
    (rmsVal < 0.001);
  const signalText = isSilent ? 'Silence' : 'Audio detected';

  const sessionText = `${view?.generation ?? 0} / ${view?.sequence ?? 0}`;

  const statusText = activeState[0].toUpperCase() + activeState.slice(1);

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
      (rmsVal < 0.001);

    // Waveform line styling: green/cyan glow
    ctx.shadowBlur = 8;
    ctx.shadowColor = 'rgba(34, 197, 94, 0.65)';
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    if (isWaveformSilent) {
      // Synthetic preview: subtle smooth ambient sine wave
      const points = 64;
      const step = width / (points - 1);
      for (let i = 0; i < points; i++) {
        const x = i * step;
        const y = midY + Math.sin(i * 0.25) * 3.5;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
    } else {
      const len = waveform.length;
      const step = width / Math.max(1, len - 1);
      for (let i = 0; i < len; i++) {
        const x = i * step;
        const sample = Math.max(-1, Math.min(1, waveform[i] ?? 0));
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
  }, [activeFrame, isVisible, rmsVal]);

  if (!shouldRender) {
    return null;
  }

  const melBands =
    activeFrame.mel && activeFrame.mel.length >= 64
      ? activeFrame.mel.slice(0, 64)
      : Array.from({ length: 64 }, (_, i) => activeFrame.mel?.[i] ?? 0);

  return (
    <section
      className={`diagnostics-meter-container diagnostics-sidebar ${isClosing ? 'is-closing' : 'is-open'}`}
      data-testid="diagnostics-meter"
      aria-label="Real-time Audio Diagnostics"
    >
      <header className="diagnostics-meter-header">
        <div className="diagnostics-meter-title-wrap">
          <div
            className={`diagnostics-beat-led ${activeFrame.beat ? 'is-beat' : ''}`}
            data-testid="beat-flash-indicator"
            aria-label={activeFrame.beat ? 'Beat flash active' : 'Beat flash inactive'}
          />
          <h2 className="diagnostics-meter-title">Diagnostics</h2>
          <div className="diagnostics-status-wrap">
            <span className={`status-dot ${activeState}`} aria-hidden="true" />
            <span className="status-text" role="status">
              {statusText}
            </span>
          </div>
        </div>

        <div className="diagnostics-meter-header-actions">
            <button
              type="button"
              className="btn btn-minimal btn-sm diagnostics-close-btn"
              onClick={onToggle}
              aria-label="Close diagnostics"
            >
              ✕
            </button>
        </div>
      </header>

      <div className="diagnostics-visuals-row">
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

        <div
          className="diagnostics-bands-grid"
          data-testid="diagnostics-bands"
          aria-label="64-band equalizer LED bars"
        >
          {melBands.map((val, idx) => {
            const clamped = Math.max(0, Math.min(1, val));
            const heightPercent = Math.max(4, Math.round(clamped * 100));
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
      </div>

      <div className="diagnostics-telemetry-grid" role="group" aria-label="Audio telemetry">
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">Format</span>
          <span className="telemetry-value stat-value" data-testid="stat-format">
            {formatText}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">RMS</span>
          <span className="telemetry-value stat-value" aria-label="RMS" data-testid="stat-rms">
            {rmsVal.toFixed(4)}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">Peak</span>
          <span className="telemetry-value stat-value" aria-label="Peak" data-testid="stat-peak">
            {peakVal.toFixed(4)}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">Signal</span>
          <span className="telemetry-value stat-value" aria-label="Signal" data-testid="stat-signal">
            {signalText}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">Session</span>
          <span className="telemetry-value stat-value" data-testid="stat-session">
            {sessionText}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">BPM</span>
          <span className="telemetry-value stat-value" data-testid="stat-bpm">
            {activeFrame.bpm > 0 ? Math.round(activeFrame.bpm) : '--'}
          </span>
        </div>
        <div className="diagnostics-telemetry-item diagnostics-stat">
          <span className="telemetry-label stat-label">Confidence</span>
          <span className="telemetry-value stat-value" data-testid="stat-confidence">
            {activeFrame.confidence !== undefined
              ? `${Math.round(activeFrame.confidence * 100)}%`
              : '--'}
          </span>
        </div>
      </div>

      <footer className="diagnostics-shortcuts" role="group" aria-label="Keyboard shortcuts">
        <h3 className="diagnostics-shortcuts-title">Shortcuts</h3>
        <dl className="diagnostics-shortcuts-list">
          <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Change scene</dd></div>
          <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Change color</dd></div>
          <div><dt><kbd>H</kbd></dt><dd>Hide Controls</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Start / stop audio</dd></div>
          <div><dt><kbd>D</kbd></dt><dd>Toggle Diagnostics</dd></div>
          <div><dt><kbd>F</kbd> <kbd>F11</kbd></dt><dd>Toggle fullscreen</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Exit fullscreen</dd></div>
        </dl>
      </footer>
    </section>
  );
}
