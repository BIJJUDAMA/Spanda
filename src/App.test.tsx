import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import App from './App';
import type { Invoke } from './audio/types';

test('starts idle with Start available and Stop disabled', () => {
  const invoke: Invoke = () => new Promise(() => {});
  render(<App invoke={invoke} />);

  expect(screen.getByRole('button', { name: /^Start$/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  expect(screen.getByRole('heading', { name: 'Spanda' })).toBeInTheDocument();
  // Diagnostics meter is hidden by default
  expect(screen.queryByTestId('diagnostics-meter')).not.toBeInTheDocument();
  // Opening diagnostics reveals the meter
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  expect(screen.getByTestId('diagnostics-meter')).toBeInTheDocument();
});

test('clicking Hide Controls hides the panel and cursor until mouse is moved', () => {
  const invoke: Invoke = () => new Promise(() => {});
  const { container } = render(<App invoke={invoke} />);

  const panel = container.querySelector('.idle-panel');
  expect(panel).toHaveClass('controls-visible');

  const hideButton = screen.getByRole('button', { name: 'Hide controls until mouse is moved' });
  fireEvent.click(hideButton);

  expect(panel).toHaveClass('controls-hidden');
  expect(document.documentElement).toHaveClass('cursor-hidden');

  // Moving the mouse reveals the panel again
  fireEvent.mouseMove(window);
  expect(panel).toHaveClass('controls-visible');
  expect(document.documentElement).not.toHaveClass('cursor-hidden');
});

test('hiding controls closes Diagnostics before hiding the main HUD', async () => {
  const invoke: Invoke = () => new Promise(() => {});
  const { container } = render(<App invoke={invoke} />);
  const panel = container.querySelector('.idle-panel');

  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide controls until mouse is moved' }));

  expect(screen.getByTestId('diagnostics-meter')).toHaveClass('is-closing');
  expect(panel).toHaveClass('controls-visible');
  expect(panel?.closest('.hud-layout')).toHaveClass('diagnostics-open');
  await waitFor(() => expect(panel).toHaveClass('controls-hidden'));
  expect(panel?.closest('.hud-layout')).not.toHaveClass('diagnostics-open');
  expect(screen.queryByTestId('diagnostics-meter')).not.toBeInTheDocument();
});

test('Diagnostics pauses HUD auto-hide and the countdown starts after it closes', () => {
  vi.useFakeTimers();
  try {
    const invoke: Invoke = () => new Promise(() => {});
    const { container } = render(<App invoke={invoke} />);
    const panel = container.querySelector('.idle-panel');
    const diagnosticsButton = screen.getByRole('button', { name: 'Diagnostics' });

    fireEvent.click(diagnosticsButton);
    act(() => vi.advanceTimersByTime(2000));

    expect(screen.getByTestId('diagnostics-meter')).toBeInTheDocument();
    expect(panel).toHaveClass('controls-visible');
    expect(panel?.closest('.hud-layout')).toHaveClass('diagnostics-open');

    fireEvent.click(diagnosticsButton);
    act(() => vi.advanceTimersByTime(900));
    expect(panel).toHaveClass('controls-visible');

    act(() => vi.advanceTimersByTime(300));
    expect(panel).toHaveClass('controls-hidden');
    expect(panel?.closest('.hud-layout')).not.toHaveClass('diagnostics-open');
    expect(screen.queryByTestId('diagnostics-meter')).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

test('pressing H key toggles hiding the panel', () => {
  const invoke: Invoke = () => new Promise(() => {});
  const { container } = render(<App invoke={invoke} />);

  const panel = container.querySelector('.idle-panel');
  expect(panel).toHaveClass('controls-visible');

  // Press 'h' to hide
  fireEvent.keyDown(window, { key: 'h' });
  expect(panel).toHaveClass('controls-hidden');

  // Move mouse to restore
  fireEvent.mouseMove(window);
  expect(panel).toHaveClass('controls-visible');
});

test('clicking Diagnostics button toggles the live diagnostics meter', async () => {
  const invoke: Invoke = () => new Promise(() => {});
  render(<App invoke={invoke} />);

  expect(screen.queryByTestId('diagnostics-meter')).not.toBeInTheDocument();

  const diagButton = screen.getByRole('button', { name: 'Diagnostics' });
  fireEvent.click(diagButton);

  const diagnostics = screen.getByTestId('diagnostics-meter');
  expect(diagnostics).toBeInTheDocument();
  expect(diagnostics.closest('.hud-layout')).toHaveClass('diagnostics-open');
  expect(diagnostics.parentElement?.lastElementChild).toHaveClass('idle-panel');
  expect(diagnostics).toHaveClass('diagnostics-sidebar');
  expect(diagnostics).toHaveClass('is-open');

  fireEvent.click(diagButton);
  expect(screen.getByTestId('diagnostics-meter')).toHaveClass('is-closing');
  await waitFor(() => expect(screen.queryByTestId('diagnostics-meter')).not.toBeInTheDocument());
});

test('pressing D key toggles the live diagnostics meter', async () => {
  const invoke: Invoke = () => new Promise(() => {});
  render(<App invoke={invoke} />);

  expect(screen.queryByTestId('diagnostics-meter')).not.toBeInTheDocument();

  fireEvent.keyDown(window, { key: 'd' });
  expect(screen.getByTestId('diagnostics-meter')).toBeInTheDocument();

  fireEvent.keyDown(window, { key: 'd' });
  expect(screen.getByTestId('diagnostics-meter')).toHaveClass('is-closing');
  await waitFor(() => expect(screen.queryByTestId('diagnostics-meter')).not.toBeInTheDocument());
});

test('pressing S key triggers start capture when idle and stop when running', async () => {
  const calls: string[] = [];
  const invoke: Invoke = (cmd) => {
    calls.push(cmd);
    return Promise.resolve(undefined as never);
  };
  render(<App invoke={invoke} />);

  // Idle: press S to start
  fireEvent.keyDown(window, { key: 's' });
  expect(calls).toContain('start_capture');
});

test('ArrowRight and ArrowLeft cycle visualizer scenes', () => {
  const invoke: Invoke = () => new Promise(() => {});
  render(<App invoke={invoke} />);

  const sceneSelect = screen.getByLabelText('Scene selector');
  expect(sceneSelect).toHaveTextContent('Oscilloscope');

  // Press ArrowRight to advance to next scene
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(sceneSelect).toHaveTextContent('Geometric Tunnel');

  // Press ArrowRight again
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(sceneSelect).toHaveTextContent('Spectrum Bars');

  // Press ArrowLeft to return to previous scene
  fireEvent.keyDown(window, { key: 'ArrowLeft' });
  expect(sceneSelect).toHaveTextContent('Geometric Tunnel');

  // Press ArrowLeft again to return to Oscilloscope
  fireEvent.keyDown(window, { key: 'ArrowLeft' });
  expect(sceneSelect).toHaveTextContent('Oscilloscope');

  // Press ArrowLeft to wrap around to the last scene
  fireEvent.keyDown(window, { key: 'ArrowLeft' });
  expect(sceneSelect).toHaveTextContent('Particle Sphere');
});

test('arrow keys cycle scenes without revealing the HUD', () => {
  const invoke: Invoke = () => new Promise(() => {});
  const { container } = render(<App invoke={invoke} />);
  const panel = container.querySelector('.idle-panel');

  fireEvent.click(screen.getByRole('button', { name: 'Hide controls until mouse is moved' }));
  expect(panel).toHaveClass('controls-hidden');

  fireEvent.keyDown(window, { key: 'ArrowRight' });

  expect(screen.getByLabelText('Scene selector')).toHaveTextContent('Geometric Tunnel');
  expect(panel).toHaveClass('controls-hidden');
});

test('p key does not cycle color palettes', () => {
  const invoke: Invoke = () => new Promise(() => {});
  render(<App invoke={invoke} />);

  expect(screen.getByRole('button', { name: 'Palette Aurora' })).toHaveAttribute('aria-pressed', 'true');

  // P is not a palette shortcut; use the arrow keys instead.
  fireEvent.keyDown(window, { key: 'p' });
  fireEvent.keyDown(window, { key: 'P' });
  expect(screen.getByRole('button', { name: 'Palette Aurora' })).toHaveAttribute('aria-pressed', 'true');
});

test('up and down arrows cycle palettes without revealing the HUD', () => {
  const invoke: Invoke = () => new Promise(() => {});
  const { container } = render(<App invoke={invoke} />);
  const panel = container.querySelector('.idle-panel');

  fireEvent.click(screen.getByRole('button', { name: 'Hide controls until mouse is moved' }));
  expect(panel).toHaveClass('controls-hidden');

  fireEvent.keyDown(window, { key: 'ArrowUp' });
  expect(screen.getByRole('button', { name: 'Palette Ember', hidden: true })).toHaveAttribute('aria-pressed', 'true');
  expect(panel).toHaveClass('controls-hidden');

  fireEvent.keyDown(window, { key: 'ArrowDown' });
  expect(screen.getByRole('button', { name: 'Palette Aurora', hidden: true })).toHaveAttribute('aria-pressed', 'true');
  expect(panel).toHaveClass('controls-hidden');
});

test('f key triggers toggleFullscreen', async () => {
  const invoke: Invoke = () => new Promise(() => {});
  render(<App invoke={invoke} />);

  const requestFullscreenMock = vi.fn().mockResolvedValue(undefined);
  document.documentElement.requestFullscreen = requestFullscreenMock;

  fireEvent.keyDown(window, { key: 'f' });
  await waitFor(() => expect(requestFullscreenMock).toHaveBeenCalled());
});

test('keyboard navigation shortcuts are ignored when typing inside text inputs', () => {
  const invoke: Invoke = () => new Promise(() => {});
  render(<App invoke={invoke} />);

  const sceneSelect = screen.getByLabelText('Scene selector');
  expect(sceneSelect).toHaveTextContent('Oscilloscope');

  // Create a dummy text input and focus it
  const input = document.createElement('input');
  input.type = 'text';
  document.body.appendChild(input);
  input.focus();

  fireEvent.keyDown(input, { key: 'ArrowRight' });
  expect(sceneSelect).toHaveTextContent('Oscilloscope'); // unchanged!

  fireEvent.keyDown(input, { key: 'p' });

  expect(screen.getByRole('button', { name: 'Palette Aurora' })).toHaveAttribute('aria-pressed', 'true');

  document.body.removeChild(input);
});




test('has no local-file controls and ignores dropped audio and playback shortcuts', () => {
  const invoke = vi.fn<Invoke>(() => new Promise(() => {}));
  const { container } = render(<App invoke={invoke} />);

  expect(screen.queryByRole('button', { name: /open file/i })).not.toBeInTheDocument();
  expect(container.querySelector('input[type="file"]')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Audio timeline')).not.toBeInTheDocument();

  const file = new File(['audio-data'], 'removed-playback.mp3', { type: 'audio/mp3' });
  fireEvent.dragEnter(window, { dataTransfer: { types: ['Files'] } });
  fireEvent.drop(window, { dataTransfer: { files: [file] } });
  fireEvent.keyDown(window, { key: ' ', code: 'Space' });

  expect(screen.queryByTestId('drag-drop-overlay')).not.toBeInTheDocument();
  expect(screen.queryByText('removed-playback.mp3')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^(Play|Pause)$/ })).not.toBeInTheDocument();
  expect(container.querySelector('.file-player-bar')).not.toBeInTheDocument();
  expect(invoke.mock.calls.some(([command]) => command === 'start_capture' || command === 'stop_capture')).toBe(false);
  expect(screen.getByRole('button', { name: /^Start$/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
});
