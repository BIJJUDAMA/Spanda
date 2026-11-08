import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsMeter } from './DiagnosticsMeter';
import { defaultAnalysisFrame, idleView, type AudioView, type UnifiedAnalysisFrame } from '../audio/types';

describe('DiagnosticsMeter component', () => {
  const createMockCtx = () => ({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    shadowBlur: 0,
    shadowColor: '',
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('stays mounted when the HUD is hidden', () => {
    const { container } = render(
      <DiagnosticsMeter
        frame={defaultAnalysisFrame}
        source="idle"
        isVisible={false}
      />
    );

    expect(container.firstChild).not.toBeNull();
    expect(screen.getByTestId('diagnostics-meter')).toBeInTheDocument();
  });

  it('renders meter container and waveform canvas with exact dimensions (240x48px)', () => {
    render(
      <DiagnosticsMeter
        frame={defaultAnalysisFrame}
        source="idle"
        isVisible={true}
      />
    );

    const meter = screen.getByTestId('diagnostics-meter');
    expect(meter).toBeInTheDocument();

    const canvas = screen.getByTestId('diagnostics-waveform') as HTMLCanvasElement;
    expect(canvas).toBeInTheDocument();
    expect(canvas.width).toBe(240);
    expect(canvas.height).toBe(48);
  });

  it('shows the keyboard shortcuts in the diagnostics footer', () => {
    render(
      <DiagnosticsMeter
        frame={defaultAnalysisFrame}
        source="idle"
        isVisible={true}
      />
    );

    expect(screen.getByRole('group', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByText('Change scene')).toBeInTheDocument();
    expect(screen.getByText('Change color')).toBeInTheDocument();
    expect(screen.getByText('Hide Controls')).toBeInTheDocument();
    expect(screen.queryByText('Play / pause local file')).not.toBeInTheDocument();
  });

  it('renders 64 equalizer mini-LED bars displaying mel spectrum', () => {
    const mockMel = new Array(64).fill(0.5);
    mockMel[0] = 0.8;
    mockMel[63] = 0.2;

    const frame: UnifiedAnalysisFrame = {
      ...defaultAnalysisFrame,
      mel: mockMel,
    };

    render(
      <DiagnosticsMeter
        frame={frame}
        source="wasapi"
        isVisible={true}
      />
    );

    const bandsContainer = screen.getByTestId('diagnostics-bands');
    expect(bandsContainer).toBeInTheDocument();
    expect(bandsContainer.children).toHaveLength(64);

    const firstBar = screen.getByTestId('diagnostics-bar-0');
    expect(firstBar).toHaveStyle({ height: '80%' });

    const lastBar = screen.getByTestId('diagnostics-bar-63');
    expect(lastBar).toHaveStyle({ height: '20%' });
  });

  it('omits the beat indicator even when a beat is detected', () => {
    const { rerender } = render(
      <DiagnosticsMeter
        frame={{ ...defaultAnalysisFrame, beat: false }}
        source="wasapi"
        isVisible={true}
      />
    );

    const indicator = screen.queryByTestId('beat-flash-indicator');
    expect(indicator).not.toBeInTheDocument();

    rerender(
      <DiagnosticsMeter
        frame={{ ...defaultAnalysisFrame, beat: true }}
        source="wasapi"
        isVisible={true}
      />
    );

    expect(screen.queryByTestId('beat-flash-indicator')).not.toBeInTheDocument();
  });

  it('renders real-time numerical readouts: RMS, Peak, BPM, and Confidence', () => {
    const testFrame: UnifiedAnalysisFrame = {
      ...defaultAnalysisFrame,
      rms: 0.3542,
      peak: 0.8921,
      bpm: 126.4,
      confidence: 0.92,
    };

    render(
      <DiagnosticsMeter
        frame={testFrame}
        source="wasapi"
        isVisible={true}
      />
    );

    expect(screen.getByTestId('stat-rms')).toHaveTextContent('-9.0 dBFS');
    expect(screen.getByTestId('stat-peak')).toHaveTextContent('-1.0 dBFS');
    expect(screen.getByText('Tempo confidence')).toBeInTheDocument();
    expect(screen.getByTestId('stat-bpm')).toHaveTextContent('126');
    expect(screen.getByTestId('stat-confidence')).toHaveTextContent('92%');
  });

  it('renders fallback values when BPM is zero or missing', () => {
    render(
      <DiagnosticsMeter
        frame={{ ...defaultAnalysisFrame, bpm: 0, confidence: 0 }}
        source="idle"
        isVisible={true}
      />
    );

    expect(screen.getByTestId('stat-bpm')).toHaveTextContent('--');
    expect(screen.getByTestId('stat-confidence')).toHaveTextContent('0%');
  });

  it('omits the redundant source pill for wasapi and idle', () => {
    const { rerender } = render(
      <DiagnosticsMeter
        frame={defaultAnalysisFrame}
        source="wasapi"
        isVisible={true}
      />
    );

    expect(screen.queryByTestId('diagnostics-source-badge')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    rerender(
      <DiagnosticsMeter
        frame={defaultAnalysisFrame}
        source="idle"
        isVisible={true}
      />
    );
    expect(screen.queryByTestId('diagnostics-source-badge')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not offer a separate close button', () => {
    render(<DiagnosticsMeter frame={defaultAnalysisFrame} isVisible />);
    expect(screen.queryByRole('button', { name: /close diagnostics/i })).not.toBeInTheDocument();
  });

  it('renders live waveform on canvas using 2D context', () => {
    const mockCtx = createMockCtx();
    const getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(mockCtx as unknown as RenderingContext);

    const activeWaveform = new Array(64).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.5);
    const frame: UnifiedAnalysisFrame = {
      ...defaultAnalysisFrame,
      rms: 0.25,
      waveform: activeWaveform,
    };

    render(
      <DiagnosticsMeter
        frame={frame}
        source="wasapi"
        isVisible={true}
      />
    );

    expect(getContextSpy).toHaveBeenCalledWith('2d');
    expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 240, 48);
    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.lineTo).toHaveBeenCalled();
  });

  it('renders a flat waveform and no spectrum energy during silence', () => {
    const mockCtx = createMockCtx();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      mockCtx as unknown as RenderingContext
    );

    const silentFrame: UnifiedAnalysisFrame = {
      ...defaultAnalysisFrame,
      rms: 0,
      waveform: new Array(64).fill(0),
    };

    render(
      <DiagnosticsMeter
        frame={silentFrame}
        source="idle"
        isVisible={true}
      />
    );

    expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 240, 48);
    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
    expect(mockCtx.moveTo.mock.calls.every(([, y]) => y === 24)).toBe(true);
    expect(mockCtx.lineTo.mock.calls.every(([, y]) => y === 24)).toBe(true);
    expect(screen.getByTestId('diagnostics-bar-0')).toHaveStyle({ height: '0%' });
    expect(screen.getByTestId('stat-rms')).toHaveTextContent('−∞ dBFS');
  });

  it('renders Format, Signal, and Status without Output or Session', () => {
    const testView: AudioView = {
      ...idleView,
      state: 'running',
      deviceName: 'Speakers (High Definition Audio)',
      sampleRate: 48000,
      channels: 2,
      generation: 2,
      sequence: 120,
      silent: false,
    };

    render(
      <DiagnosticsMeter
        view={testView}
        source="wasapi"
        isVisible={true}
      />
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stat-output')).not.toBeInTheDocument();
    expect(screen.getByTestId('stat-format')).toHaveTextContent('48000 Hz / 2 channels');
    expect(screen.getByTestId('stat-signal')).toHaveTextContent('Audio detected');
    expect(screen.queryByTestId('stat-session')).not.toBeInTheDocument();
  });

  it('shows independent channel peaks on a bounded dB scale', () => {
    render(<DiagnosticsMeter frame={{ ...defaultAnalysisFrame, leftPeak: 1, rightPeak: 0.1 }} isVisible />);
    const left = screen.getByRole('meter', { name: 'Left channel peak' });
    const right = screen.getByRole('meter', { name: 'Right channel peak' });
    expect(left).toHaveAttribute('aria-valuenow', '0');
    expect(left).toHaveAttribute('aria-valuetext', '0.0 dBFS');
    expect(left.firstChild).toHaveStyle({ width: '100%' });
    expect(right).toHaveAttribute('aria-valuenow', '-20');
    expect(right).toHaveAttribute('aria-valuetext', '-20.0 dBFS');
  });

  it('handles silent, over-full-scale, and invalid input without invalid meter values', () => {
    const { rerender } = render(<DiagnosticsMeter frame={{ ...defaultAnalysisFrame, rms: NaN, peak: 2, leftPeak: NaN, rightPeak: 2, mel: [NaN, -1, 2] }} isVisible />);
    expect(screen.getByTestId('stat-rms')).toHaveTextContent('−∞ dBFS');
    expect(screen.getByTestId('stat-peak')).toHaveTextContent('6.0 dBFS');
    expect(screen.getByRole('meter', { name: 'Left channel peak' })).toHaveAttribute('aria-valuenow', '-60');
    expect(screen.getByRole('meter', { name: 'Right channel peak' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByTestId('diagnostics-bar-0')).toHaveStyle({ height: '0%' });
    expect(screen.getByTestId('diagnostics-bar-2')).toHaveStyle({ height: '100%' });
    rerender(<DiagnosticsMeter frame={defaultAnalysisFrame} isVisible />);
    for (const meter of screen.getAllByRole('meter')) expect(meter.firstChild).toHaveStyle({ width: '0%' });
  });
});
