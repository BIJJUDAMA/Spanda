import type { RecordingState } from '../recording/recorder';
export function RecordingControls({ state, captureRunning, onStart, onStop }: { state: RecordingState; captureRunning: boolean; onStart: () => void; onStop: () => void }) {
  const busy = state.phase === 'starting' || state.phase === 'saving';
  const recording = state.phase === 'recording';
  const seconds = Math.floor(state.elapsed / 1000);
  return <div className="recording-controls control-card" role="group" aria-label="Video recording">
    <div className="recording-heading"><span>Record with sound</span>
      <button type="button" className="btn" disabled={busy || (!recording && !captureRunning)} onClick={recording ? onStop : onStart}>
        {recording ? `Stop & save · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : state.phase === 'starting' ? 'Preparing…' : state.phase === 'saving' ? 'Saving…' : 'Record clip'}
      </button>
    </div>
    <p className="recording-note">{captureRunning ? 'Visuals + system audio · WebM · up to 720p / 30 fps · 5 min limit' : 'Press Start to enable recording with system audio.'}</p>
    {state.phase === 'saved' && <p role="status" className="recording-result">Saved to {state.path}</p>}
    {state.phase === 'error' && <p role="alert" className="error-banner">{state.message}</p>}
  </div>;
}
