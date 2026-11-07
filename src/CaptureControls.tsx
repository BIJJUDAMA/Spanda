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
        <Tooltip content="Start capture" shortcut={!active ? 'S' : undefined}>
          <button
            type="button"
            className={`btn capture-start-button ${!active ? 'is-selected' : ''}`}
            disabled={!client || view.pending || active || view.state === 'stopping'}
            onClick={() => { void client?.start().catch(() => {}); }}
          >
            Start
          </button>
        </Tooltip>
        <Tooltip content="Stop capture" shortcut={active ? 'S' : undefined}>
          <button
            type="button"
            className={`btn ${active ? 'is-selected' : ''}`}
            disabled={!client || view.pending || (!active && view.state !== 'error')}
            onClick={handleStop}
          >
            Stop
          </button>
        </Tooltip>
      </div>

      {error && <p role="alert" className="error-banner">{error.message} ({error.code})</p>}
      {view.state === 'recovering' && (
        <p className="notice">Windows output is unavailable or changing. Retrying automatically; you can Stop at any time.</p>
      )}
    </div>
  );
}

