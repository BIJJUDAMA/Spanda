import { fireEvent, render, screen } from '@testing-library/react';
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

  it('renders nothing when isVisible is false', () => {
    const { container } = render(
      <DiagnosticsMeter
        frame={defaultAnalysisFrame}
        source="idle"
        isVisible={false}
        onToggle={vi.fn()}
      />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('diagnostics-meter')).not.toBeInTheDocument();
  });

  it('renders meter container and waveform canvas with exact dimensions (240x48px)', () => {
    render(
      <DiagnosticsMeter
        frame={defaultAnalysisFrame}
        source="idle"
        isVisible={true}
        onToggle={vi.fn()}
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
        onToggle={vi.fn()}
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
        onToggle={vi.fn()}
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

  it('toggles is-beat class on beat flash indicator when frame.beat is true/false', () => {
    const { rerender } = render(
      <DiagnosticsMeter
        frame={{ ...defaultAnalysisFrame, beat: false }}
        source="wasapi"
        isVisible={true}
        onToggle={vi.fn()}
      />
    );

    const indicator = screen.getByTestId('beat-flash-indicator');
    expect(indicator).not.toHaveClass('is-beat');

    rerender(
      <DiagnosticsMeter
        frame={{ ...defaultAnalysisFrame, beat: true }}
        source="wasapi"
        isVisible={true}
        onToggle={vi.fn()}
      />
    );

    expect(indicator).toHaveClass('is-beat');
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
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByTestId('stat-rms')).toHaveTextContent('0.3542');
    expect(screen.getByTestId('stat-peak')).toHaveTextContent('0.8921');
    expect(screen.getByTestId('stat-bpm')).toHaveTextContent('126');
    expect(screen.getByTestId('stat-confidence')).toHaveTextContent('92%');
  });

  it('renders fallback values when BPM is zero or missing', () => {
    render(
      <DiagnosticsMeter
        frame={{ ...defaultAnalysisFrame, bpm: 0, confidence: 0 }}
        source="idle"
        isVisible={true}
        onToggle={vi.fn()}
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
        onToggle={vi.fn()}
      />
    );

    expect(screen.queryByTestId('diagnostics-source-badge')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Running');

    rerender(
      <DiagnosticsMeter
        frame={defaultAnalysisFrame}
        source="idle"
        isVisible={true}
        onToggle={vi.fn()}
      />
    );
    expect(screen.queryByTestId('diagnostics-source-badge')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Idle');
  });

  it('calls onToggle when clicking the close button', () => {
    const onToggleMock = vi.fn();
    render(
      <DiagnosticsMeter
        frame={defaultAnalysisFrame}
        source="idle"
        isVisible={true}
        onToggle={onToggleMock}
      />
    );

    const closeBtn = screen.getByRole('button', { name: /close diagnostics/i });
    fireEvent.click(closeBtn);
    expect(onToggleMock).toHaveBeenCalledTimes(1);
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
        onToggle={vi.fn()}
      />
    );

    expect(getContextSpy).toHaveBeenCalledWith('2d');
    expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 240, 48);
    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
    expect(mockCtx.moveTo).toHaveBeenCalled();
    expect(mockCtx.lineTo).toHaveBeenCalled();
  });

  it('renders synthetic preview when audio waveform is silent', () => {
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
        onToggle={vi.fn()}
      />
    );

    expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 240, 48);
    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();
  });

  it('renders Format, Signal, Session, and Status without the output label', () => {
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
        onToggle={vi.fn()}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Running');
    expect(screen.queryByTestId('stat-output')).not.toBeInTheDocument();
    expect(screen.getByTestId('stat-format')).toHaveTextContent('48000 Hz / 2 channels');
    expect(screen.getByTestId('stat-signal')).toHaveTextContent('Audio detected');
    expect(screen.getByTestId('stat-session')).toHaveTextContent('2 / 120');
  });
});
