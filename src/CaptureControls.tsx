import type { AudioClient } from './audio/client';
import type { AudioView } from './audio/types';
import { Tooltip } from './components/ui/tooltip';

export interface CaptureControlsProps {
  view: AudioView;
  client: AudioClient | null;
  loadedFileName?: string | null;
  isFilePlaying?: boolean;
  onStopFile?: () => void;
}

export function CaptureControls({
  view,
  client,
  isFilePlaying = false,
  onStopFile,
}: CaptureControlsProps) {
  const isCaptureActive = ['starting', 'running', 'recovering'].includes(view.state);
  const active = isCaptureActive || isFilePlaying;
  const error = view.clientError ?? view.error;
  const starting = view.state === 'starting' || (view.pending && !isCaptureActive && view.state !== 'stopping');
  const stopping = view.state === 'stopping' || (view.pending && isCaptureActive && view.state !== 'starting');
  const status = error ? 'Capture needs attention.'
    : starting ? 'Starting system audio capture…'
    : stopping ? 'Stopping capture…'
    : view.state === 'recovering' ? 'Waiting for the Windows output to return…'
    : isCaptureActive ? 'Visualizing system audio. Stop leaves your music playing.'
    : 'Start to visualize the audio playing on your PC.';
  const handleStop = () => {
    if (isCaptureActive) {
      void client?.stop().catch(() => {});
    }
    if (isFilePlaying && onStopFile) {
      onStopFile();
    }
  };

  return (
    <div className="capture-container">
      <div className="controls capture-segmented-track" role="group" aria-label="Capture controls">
        <span className={`capture-sliding-indicator ${active ? 'slide-to-stop' : 'slide-to-start'}`} aria-hidden="true" />
        <Tooltip content={active ? 'System audio capture is already active' : 'Visualize system audio without changing playback'} shortcut={!active ? 'S' : undefined}>
          <button
            type="button"
            className={`btn capture-start-button ${!active ? 'is-selected' : ''}`}
            disabled={!client || view.pending || active || view.state === 'stopping'}
            aria-busy={starting}
            onClick={() => { void client?.start().catch(() => {}); }}
          >
            {starting ? 'Starting…' : 'Start'}
          </button>
        </Tooltip>
        <Tooltip content={active ? 'Stop visualization capture; your music keeps playing' : 'Start capture before stopping it'} shortcut={active ? 'S' : undefined}>
          <button
            type="button"
            className={`btn ${active ? 'is-selected' : ''}`}
            disabled={!client || view.pending || (!active && view.state !== 'error')}
            aria-busy={stopping}
            onClick={handleStop}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </Tooltip>
      </div>
      <p className="capture-guidance" aria-live="polite" aria-atomic="true">{status}</p>

      {error && <p role="alert" className="error-banner">{error.message} ({error.code})</p>}
      {view.state === 'recovering' && (
        <p className="notice">Windows output is unavailable or changing. Retrying automatically; you can Stop at any time.</p>
      )}
    </div>
  );
}

