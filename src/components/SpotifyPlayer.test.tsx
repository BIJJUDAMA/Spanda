import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { Listen } from '../audio/types';
import { SpotifyPlayer, mediaTime, type SpotifyState } from './SpotifyPlayer';

const track: SpotifyState = {
  revision: 2, sessionId: 1, available: true, title: 'A track', artist: 'An artist', album: 'An album',
  artwork: 'data:image/png;base64,AA==', playback: 'playing', positionMs: 3000, durationMs: 120000,
  seekStartMs: 0, seekEndMs: 120000, canToggle: true, canPrevious: true, canNext: true, canSeek: true, error: null,
};

function setup(initial = track) {
  let update: (state: SpotifyState) => void = () => {};
  const dispose = vi.fn();
  const listen: Listen = (_name, handler) => { update = state => handler({ payload: state as never }); return dispose; };
  const invoke = vi.fn(async (name: string, _args?: Record<string, unknown>): Promise<unknown> => name === 'get_spotify_state' ? initial : undefined);
  const rendered = render(<SpotifyPlayer invoke={invoke} listen={listen} />);
  return { ...rendered, invoke, dispose, update: (state: SpotifyState) => act(() => update(state)) };
}

test('shows metadata and sends controls to the displayed session while capture is independent', async () => {
  const { invoke } = setup();
  await screen.findByText('A track');
  expect(screen.getByText('An artist · An album')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Pause Spotify' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('control_spotify', { sessionId: 1, action: 'toggle', positionMs: undefined }));
  expect(invoke).not.toHaveBeenCalledWith('start_capture');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next Spotify track' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Next Spotify track' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('control_spotify', expect.objectContaining({ action: 'next' })));
});

test('capabilities disable unavailable actions and absent metadata has honest fallbacks', async () => {
  setup({ ...track, title: '', artist: '', album: '', artwork: null, canToggle: false, canNext: false, canPrevious: false, canSeek: false });
  await screen.findByText('Untitled track');
  expect(screen.getByText('Unknown artist')).toBeInTheDocument();
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  expect(screen.getByRole('slider')).toBeDisabled();
});

test('closing Spotify clears artwork, metadata and draft seek; older events cannot restore them', async () => {
  const ui = setup();
  await screen.findByText('A track');
  fireEvent.change(screen.getByRole('slider'), { target: { value: '45000' } });
  ui.update({ ...track, revision: 3, sessionId: 2, available: false, title: '', artist: '', album: '', artwork: null });
  expect(screen.getByText('Spotify unavailable')).toBeInTheDocument();
  expect(screen.queryByText('A track')).not.toBeInTheDocument();
  expect(ui.container.querySelector('img')).toBeNull();
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  ui.update(track);
  expect(screen.queryByText('A track')).not.toBeInTheDocument();
  expect(ui.invoke).not.toHaveBeenCalledWith('control_spotify', expect.anything());
});

test('seek commits once on release and keyboard seek is supported', async () => {
  const { invoke } = setup();
  await screen.findByText('A track');
  const slider = screen.getByRole('slider');
  fireEvent.change(slider, { target: { value: '42000' } });
  expect(invoke).not.toHaveBeenCalledWith('control_spotify', expect.anything());
  fireEvent.pointerUp(slider);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('control_spotify', { sessionId: 1, action: 'seek', positionMs: 42000 }));
  await waitFor(() => expect(slider).toBeEnabled());
  fireEvent.change(slider, { target: { value: '43000' } });
  fireEvent.keyUp(slider, { key: 'ArrowRight' });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('control_spotify', expect.objectContaining({ positionMs: 43000 })));
});

test('reports a rejected command and releases listener on unmount', async () => {
  const ui = setup();
  await screen.findByText('A track');
  ui.invoke.mockRejectedValueOnce('Spotify declined the command');
  fireEvent.click(screen.getByRole('button', { name: 'Previous Spotify track' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Spotify declined');
  ui.unmount();
  expect(ui.dispose).toHaveBeenCalledOnce();
});

test('a snapshot that resolves after a newer event does not replace it', async () => {
  let resolve: (state: SpotifyState) => void = () => {};
  let update: (state: SpotifyState) => void = () => {};
  const invoke = vi.fn(() => new Promise<SpotifyState>(done => { resolve = done; }));
  const listen: Listen = (_name, handler) => { update = state => handler({ payload: state as never }); return () => {}; };
  render(<SpotifyPlayer invoke={invoke} listen={listen} />);
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  act(() => update({ ...track, revision: 5, title: 'New track' }));
  await act(async () => resolve(track));
  expect(screen.getByText('New track')).toBeInTheDocument();
});

test('formats elapsed time', () => {
  expect(mediaTime(-1)).toBe('0:00');
  expect(mediaTime(125999)).toBe('2:05');
});

test('a listener that finishes registering after unmount is still released', async () => {
  const dispose = vi.fn();
  let finish: (dispose: () => void) => void = () => {};
  const listen: Listen = () => new Promise(resolve => { finish = resolve; });
  const invoke = vi.fn(async () => track);
  const ui = render(<SpotifyPlayer invoke={invoke} listen={listen} />);
  await act(async () => {});
  ui.unmount();
  await act(async () => finish(dispose));
  expect(dispose).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
});

test('a track change cancels an unfinished seek without issuing a command', async () => {
  const ui = setup();
  await screen.findByText('A track');
  const slider = screen.getByRole('slider');
  fireEvent.change(slider, { target: { value: '42000' } });
  ui.update({ ...track, revision: 3, title: 'Another track', positionMs: 0 });
  fireEvent.pointerUp(slider);
  expect(ui.invoke).not.toHaveBeenCalledWith('control_spotify', expect.anything());
});

test('transport failure clears stale controls and a later event restores the player', async () => {
  let update: (state: SpotifyState) => void = () => {};
  const listen: Listen = (_name, handler) => { update = state => handler({ payload: state as never }); return () => {}; };
  const invoke = vi.fn(async (): Promise<unknown> => { throw new Error('offline'); });
  render(<SpotifyPlayer invoke={invoke} listen={listen} />);
  expect(await screen.findByRole('status')).toHaveTextContent('Spotify controls unavailable');
  expect(screen.getByRole('button', { name: 'Play Spotify' })).toBeDisabled();
  act(() => update(track));
  expect(screen.getByText('A track')).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('snapshots work when event subscription is denied', async () => {
  const listen: Listen = () => Promise.reject(new Error('event denied'));
  const invoke = vi.fn(async () => track);
  render(<SpotifyPlayer invoke={invoke} listen={listen} />);
  expect(await screen.findByText('A track')).toBeInTheDocument();
});

test('seek previews its destination and retains it until a newer Spotify timeline confirms it', async () => {
  const ui = setup();
  await screen.findByText('A track');
  const slider = screen.getByRole('slider');
  fireEvent.change(slider, { target: { value: '42000' } });
  expect(screen.getByText('Release to seek to 0:42')).toBeInTheDocument();
  fireEvent.pointerUp(slider);
  await waitFor(() => expect(slider).toBeEnabled());
  expect(slider).toHaveValue('42000');
  ui.update({ ...track, revision: 3, positionMs: 3000 });
  expect(slider).toHaveValue('42000');
  ui.update({ ...track, revision: 4, positionMs: 42000 });
  expect(slider).toHaveValue('42000');
  expect(screen.queryByText('Seeking to 0:42…')).not.toBeInTheDocument();
});

test('Escape cancels a seek preview without sending it', async () => {
  const ui = setup();
  await screen.findByText('A track');
  const slider = screen.getByRole('slider');
  fireEvent.change(slider, { target: { value: '42000' } });
  fireEvent.keyDown(slider, { key: 'Escape' });
  fireEvent.pointerUp(slider);
  expect(slider).toHaveValue('3000');
  expect(ui.invoke).not.toHaveBeenCalledWith('control_spotify', expect.anything());
});

test('pending Spotify commands show their intent without claiming playback has changed', async () => {
  const ui = setup();
  await screen.findByText('A track');
  let complete!: () => void;
  ui.invoke.mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve(undefined); }));
  fireEvent.click(screen.getByRole('button', { name: 'Pause Spotify' }));
  expect(screen.getByText('Pausing Spotify…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Pause Spotify' })).toBeDisabled();
  await act(async () => complete());
  expect(screen.getByText('Request sent to Spotify')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Pause Spotify' })).toBeEnabled();
  ui.update({ ...track, revision: 3, playback: 'paused' });
  expect(screen.getByRole('button', { name: 'Play Spotify' })).toBeEnabled();
  expect(screen.queryByText('Request sent to Spotify')).not.toBeInTheDocument();
});

test('an unconfirmed seek times out and restores the reported position', async () => {
  setup();
  await screen.findByText('A track');
  vi.useFakeTimers();
  try {
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '42000' } });
    await act(async () => { fireEvent.pointerUp(slider); });
    await act(async () => vi.advanceTimersByTime(5100));
    expect(screen.getByRole('status')).toHaveTextContent('Spotify did not confirm the seek');
    expect(slider).toHaveValue('3000');
  } finally { vi.useRealTimers(); }
});

test('hover previews the seek time without moving playback and clamps at the endpoints', async () => {
  const ui = setup();
  await screen.findByText('A track');
  const slider = screen.getByRole('slider');
  Object.defineProperty(slider, 'getBoundingClientRect', { value: () => ({ left: 100, width: 216 }) });
  fireEvent.pointerMove(slider, { clientX: 208, pointerType: 'mouse' });
  expect(screen.getByTestId('seek-time-preview')).toHaveTextContent('1:00');
  expect(slider).toHaveValue('3000');
  expect(ui.invoke).not.toHaveBeenCalledWith('control_spotify', expect.anything());
  fireEvent.pointerMove(slider, { clientX: 0, pointerType: 'mouse' });
  expect(screen.getByTestId('seek-time-preview')).toHaveTextContent('0:00');
  fireEvent.pointerMove(slider, { clientX: 500, pointerType: 'mouse' });
  expect(screen.getByTestId('seek-time-preview')).toHaveTextContent('2:00');
  fireEvent.pointerLeave(slider.parentElement!);
  expect(screen.queryByTestId('seek-time-preview')).not.toBeInTheDocument();
});

test('touch movement does not create a hover preview', async () => {
  setup();
  await screen.findByText('A track');
  fireEvent.pointerMove(screen.getByRole('slider'), { clientX: 100, pointerType: 'touch' });
  expect(screen.queryByTestId('seek-time-preview')).not.toBeInTheDocument();
});
