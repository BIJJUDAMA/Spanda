import { afterEach, expect, test, vi } from 'vitest';
import { createAudioClient } from './client';
import { createAudioStore } from './store';
import { idleAnalysis, idleSnapshot, type CaptureSnapshot, type Invoke } from './types';
const clients: ReturnType<typeof createAudioClient>[] = [];
afterEach(() => { clients.forEach(c => c.dispose()); clients.length = 0; vi.useRealTimers(); });
function client(invoke: Invoke) { const c = createAudioClient(invoke); clients.push(c); return c; }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
test('blocked request never overlaps; next poll waits 33 ms after completion', async () => {
  vi.useFakeTimers(); const request = deferred<CaptureSnapshot>();
  const invoke = vi.fn<Invoke>(() => request.promise as never); const c = client(invoke);
  await vi.advanceTimersByTimeAsync(1000); expect(invoke).toHaveBeenCalledTimes(1);
  request.resolve({ ...idleSnapshot, generation: 1, sequence: 2, state: 'running' });
  await vi.advanceTimersByTimeAsync(32); expect(c.getSnapshot().state).toBe('running'); expect(invoke).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(invoke).toHaveBeenCalledTimes(2);
});
test('dispose rejects late writes and stops scheduling', async () => {
  vi.useFakeTimers(); const request = deferred<CaptureSnapshot>(); const invoke = vi.fn<Invoke>(() => request.promise as never);
  const c = client(invoke); const listener = vi.fn(); c.subscribe(listener); c.dispose();
  request.resolve({ ...idleSnapshot, state: 'running', generation: 1 }); await vi.advanceTimersByTimeAsync(1000);
  expect(c.getSnapshot().state).toBe('idle'); expect(listener).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
});
test('older generations and sequences are ignored', () => {
  const store = createAudioStore();
  expect(store.publish({ ...idleSnapshot, generation: 2, sequence: 3, state: 'running' })).toBe(true);
  expect(store.publish({ ...idleSnapshot, generation: 1, sequence: 99 })).toBe(false);
  expect(store.publish({ ...idleSnapshot, generation: 2, sequence: 2 })).toBe(false);
  expect(store.publish({ ...idleSnapshot, generation: 2, sequence: 3 })).toBe(false);
  expect(store.getSnapshot().state).toBe('running');
});
test('stop clears diagnostics and rejects a snapshot requested before stop completed', async () => {
  vi.useFakeTimers(); const request = deferred<CaptureSnapshot>(); let polls = 0;
  const invoke: Invoke = <T>(command: string) => {
    if (command !== 'get_snapshot') return Promise.resolve(undefined as T);
    return (++polls === 1 ? Promise.resolve({ ...idleSnapshot, generation: 1, sequence: 2, state: 'running', analysis: { ...idleAnalysis, rms: 0.5, peak: 1 }, silent: false }) : request.promise) as Promise<T>;
  };
  const c = client(invoke); await vi.advanceTimersByTimeAsync(33); expect(c.getSnapshot().peak).toBe(1);
  await c.stop(); request.resolve({ ...idleSnapshot, generation: 1, sequence: 3, state: 'running', analysis: { ...idleAnalysis, peak: 1 } });
  await vi.advanceTimersByTimeAsync(0); expect(c.getSnapshot().state).toBe('idle'); expect(c.getSnapshot().peak).toBe(0);
});
test('poll error is visible and polling recovers without claiming native failure', async () => {
  vi.useFakeTimers(); let fail = true;
  const c = client(<T>() => fail ? Promise.reject(new Error('IPC unavailable')) : Promise.resolve({ ...idleSnapshot, sequence: 1 } as T));
  await vi.advanceTimersByTimeAsync(0); expect(c.getSnapshot().clientError?.message).toContain('IPC unavailable'); expect(c.getSnapshot().state).toBe('idle');
  fail = false; await vi.advanceTimersByTimeAsync(33); expect(c.getSnapshot().clientError).toBeNull();
});

test('subscribes to audio_frame event and feeds frames into publishFrame', () => {
  vi.useFakeTimers();
  let eventHandler: ((event: { payload: typeof idleAnalysis }) => void) | undefined;
  const unlistenMock = vi.fn();
  const listen = vi.fn((event: string, handler: (e: { payload: typeof idleAnalysis }) => void) => {
    if (event === 'audio_frame') {
      eventHandler = handler;
    }
    return Promise.resolve(unlistenMock);
  });

  const invoke = vi.fn<Invoke>(() => new Promise(() => {}));
  const c = createAudioClient(invoke, listen as never);
  clients.push(c);

  expect(listen).toHaveBeenCalledWith('audio_frame', expect.any(Function));

  // Emit a frame
  eventHandler?.({
    payload: {
      ...idleAnalysis,
      rms: 0.72,
      peak: 0.88,
      transient: 0.65,
      bands: [0.8, 0.5, 0.3],
    },
  });

  expect(c.getSnapshot().rms).toBeCloseTo(0.72);
  expect(c.getSnapshot().peak).toBeCloseTo(0.88);
  expect(c.getSnapshot().analysis.transient).toBeCloseTo(0.65);

  // Directly verify readAudio before time advances
  const audio = c.readAudio();
  expect(audio.rms).toBeCloseTo(0.72);
  expect(audio.bass).toBeCloseTo(0.8);
  expect(audio.mid).toBeCloseTo(0.5);
  expect(audio.treble).toBeCloseTo(0.3);
  expect(audio.transient).toBeCloseTo(0.65);
  expect(audio.peak).toBeCloseTo(0.88);
});

test('peak and transient max-hold and decay across frames', () => {
  const store = createAudioStore();

  // Send a quick high-energy spike at t = 1000
  store.publishFrame({
    ...idleAnalysis,
    rms: 0.6,
    peak: 0.95,
    transient: 0.9,
  }, 1000);

  let audio = store.readAudio(1000);
  expect(audio.peak).toBeCloseTo(0.95);
  expect(audio.transient).toBeCloseTo(0.9);

  // Next frame arrives at t = 1016 and is quiet (0.05), but max-hold keeps peak and transient elevated
  store.publishFrame({
    ...idleAnalysis,
    rms: 0.1,
    peak: 0.05,
    transient: 0.05,
  }, 1016);

  audio = store.readAudio(1016);
  // Peak and transient should not plummet instantly to 0.05
  expect(audio.peak).toBeGreaterThan(0.8);
  expect(audio.transient).toBeGreaterThan(0.7);

  // After subsequent reads at t = 1032 without new spikes, decay continues
  audio = store.readAudio(1032);
  expect(audio.peak).toBeLessThan(0.95);
  expect(audio.transient).toBeLessThan(0.9);
});

test('dispose calls unlisten and ignores subsequent events', async () => {
  let eventHandler: ((event: { payload: typeof idleAnalysis }) => void) | undefined;
  const unlistenMock = vi.fn();
  const listen = vi.fn((_event: string, handler: (e: { payload: typeof idleAnalysis }) => void) => {
    eventHandler = handler;
    return Promise.resolve(unlistenMock);
  });

  const invoke = vi.fn<Invoke>(() => new Promise(() => {}));
  const c = createAudioClient(invoke, listen as never);
  // Wait for promise resolution of unlisten
  await Promise.resolve();

  c.dispose();
  expect(unlistenMock).toHaveBeenCalledTimes(1);

  // Emitting event after dispose should be ignored
  eventHandler?.({
    payload: {
      ...idleAnalysis,
      rms: 0.99,
      peak: 0.99,
    },
  });

  expect(c.getSnapshot().rms).toBe(0);
  expect(c.getSnapshot().peak).toBe(0);
});
