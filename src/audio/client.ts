import { createAudioStore } from './store';
import {
  idleSnapshot,
  type CaptureError,
  type CaptureSnapshot,
  type Invoke,
  type Listen,
  type UnifiedAnalysisFrame,
} from './types';

function captureError(value: unknown): CaptureError {
  if (typeof value === 'object' && value !== null && 'message' in value) {
    return { code: 'code' in value ? String(value.code) : 'ipc', message: String(value.message) };
  }
  return { code: 'ipc', message: String(value) };
}

export function createAudioClient(invoke: Invoke, listen?: Listen) {
  const store = createAudioStore();
  let disposed = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let actionError: CaptureError | null = null;
  let unlistenFn: (() => void) | undefined;

  if (typeof listen === 'function') {
    try {
      const res = listen<UnifiedAnalysisFrame>('audio_frame', (event) => {
        if (!disposed && event && event.payload) {
          store.publishFrame(event.payload);
        }
      });
      if (res instanceof Promise) {
        res
          .then((fn) => {
            if (disposed) {
              if (typeof fn === 'function') fn();
            } else {
              unlistenFn = fn;
            }
          })
          .catch(() => {});
      } else if (typeof res === 'function') {
        unlistenFn = res;
      }
    } catch {
      // Ignored; fallback polling remains active
    }
  }

  async function poll() {
    const requested = epoch;
    try {
      const snapshot = await invoke('get_snapshot') as CaptureSnapshot;
      if (!disposed && requested === epoch) {
        store.publish(snapshot);
        store.update({ clientError: actionError });
      }
    } catch (error) {
      if (!disposed && requested === epoch) {
        store.update({ clientError: actionError ?? captureError(error) });
      }
    } finally {
      if (!disposed) {
        timer = setTimeout(() => { void poll(); }, 33);
      }
    }
  }

  async function action(command: 'start_capture' | 'stop_capture') {
    if (disposed || store.getSnapshot().pending) return;
    epoch += 1;
    actionError = null;
    store.update({ pending: true, clientError: null });
    try {
      await invoke(command);
      if (disposed) return;
      epoch += 1;
      if (command === 'stop_capture') {
        const { generation, sequence } = store.getSnapshot();
        store.update({ ...idleSnapshot, rms: 0, peak: 0, generation, sequence, source: 'idle', sourceName: undefined });
      } else if (['idle', 'error'].includes(store.getSnapshot().state)) {
        store.update({
          state: 'starting',
          error: null,
          source: 'wasapi',
        });
      }
    } catch (error) {
      if (!disposed) {
        actionError = captureError(error);
        store.update({ clientError: actionError });
      }
      throw error;
    } finally {
      if (!disposed) store.update({ pending: false });
    }
  }

  void poll();

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    readAudio: store.readAudio,
    start: () => action('start_capture'),
    stop: () => action('stop_capture'),
    dispose() {
      disposed = true;
      epoch += 1;
      clearTimeout(timer);
      if (unlistenFn) {
        unlistenFn();
        unlistenFn = undefined;
      }
    },
  };
}

export type AudioClient = ReturnType<typeof createAudioClient>;
