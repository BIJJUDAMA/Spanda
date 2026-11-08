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

test('Diagnostics hides and returns with the main HUD without collapsing', () => {
  const { container } = render(<App invoke={() => new Promise(() => {})} />);
  const diagnostics = screen.getByTestId('diagnostics-meter');
  const layout = diagnostics.closest('.hud-layout');
  fireEvent.click(screen.getByRole('button', { name: 'Hide controls until mouse is moved' }));
  expect(layout).toHaveClass('controls-hidden');
  expect(layout).toHaveAttribute('inert');
  expect(diagnostics).toBeInTheDocument();
  expect(diagnostics).not.toHaveClass('is-closing');
  fireEvent.mouseMove(window);
  expect(layout).toHaveClass('controls-visible');
  expect(container.querySelector('.idle-panel')?.parentElement).toBe(layout);
});

test('permanent Diagnostics follows HUD auto-hide instead of preventing it', () => {
  vi.useFakeTimers();
  try {
    render(<App invoke={() => new Promise(() => {})} />);
    const diagnostics = screen.getByTestId('diagnostics-meter');
    act(() => vi.advanceTimersByTime(1100));
    expect(diagnostics.closest('.hud-layout')).toHaveClass('controls-hidden');
    expect(diagnostics).toBeInTheDocument();
  } finally { vi.useRealTimers(); }
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

test('Diagnostics is permanently attached with no toggle or close button', () => {
  render(<App invoke={() => new Promise(() => {})} />);
  expect(screen.getByTestId('diagnostics-meter')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Diagnostics' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Close diagnostics' })).not.toBeInTheDocument();
});

test('D no longer collapses Diagnostics', () => {
  render(<App invoke={() => new Promise(() => {})} />);
  fireEvent.keyDown(window, { key: 'd' });
  expect(screen.getByTestId('diagnostics-meter')).toBeInTheDocument();
  expect(screen.queryByText('Toggle Diagnostics')).not.toBeInTheDocument();
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

test('HUD stays visible while hovered or dragging, then hides after release and idle', () => {
  vi.useFakeTimers();
  try {
    const { container } = render(<App invoke={() => new Promise(() => {})} />);
    const layout = container.querySelector('.hud-layout')!;
    const panel = container.querySelector('.idle-panel')!;
    fireEvent.pointerEnter(layout);
    act(() => vi.advanceTimersByTime(2000));
    expect(panel).toHaveClass('controls-visible');
    fireEvent.pointerDown(panel);
    fireEvent.pointerLeave(layout);
    act(() => vi.advanceTimersByTime(2000));
    expect(panel).toHaveClass('controls-visible');
    fireEvent.pointerUp(window);
    act(() => vi.advanceTimersByTime(1100));
    expect(panel).toHaveClass('controls-hidden');
    expect(panel).toHaveAttribute('inert');
  } finally { vi.useRealTimers(); }
});

test('gain slider keys adjust gain without changing the scene or palette', () => {
  render(<App invoke={() => new Promise(() => {})} />);
  const gain = screen.getByRole('slider', { name: 'Sensitivity' });
  fireEvent.keyDown(gain, { key: 'ArrowRight' });
  expect(gain).toHaveAttribute('aria-valuenow', '1.05');
  expect(screen.getByLabelText('Scene selector')).toHaveValue('oscilloscope');
  fireEvent.keyDown(gain, { key: 'ArrowUp' });
  expect(screen.getByRole('button', { name: 'Palette Aurora' })).toHaveAttribute('aria-pressed', 'true');
});

test('showing the HUD returns Diagnostics immediately without a separate timer', () => {
  const { container } = render(<App invoke={() => new Promise(() => {})} />);
  fireEvent.keyDown(window, { key: 'h' });
  fireEvent.mouseMove(window);
  expect(container.querySelector('.hud-layout')).toHaveClass('controls-visible');
  expect(screen.getByTestId('diagnostics-meter')).not.toHaveClass('is-closing');
});

test('mouse use of the scene control releases focus so arrow hotkeys keep changing scenes', () => {
  render(<App invoke={() => new Promise(() => {})} />);
  const trigger = screen.getByRole('button', { name: 'Scene' });
  trigger.focus();
  fireEvent.pointerDown(trigger, { button: 0 });
  fireEvent.click(trigger);
  const option = screen.getByRole('option', { name: 'Geometric Tunnel' });
  fireEvent.pointerDown(option, { button: 0 });
  fireEvent.click(option);
  fireEvent.pointerUp(window);
  expect(trigger).not.toHaveFocus();
  fireEvent.keyDown(window, { key: 'ArrowRight' });
  expect(screen.getByTestId('scene-select')).toHaveValue('bars');
});

test('H and S remain available after focusing or clicking a HUD button', () => {
  const invoke = vi.fn<Invoke>(() => new Promise(() => {}));
  const { container } = render(<App invoke={invoke} />);
  const palette = screen.getByRole('button', { name: 'Palette Cosmic' });
  palette.focus();
  fireEvent.keyDown(palette, { key: 'd' });
  expect(screen.getByTestId('diagnostics-meter')).toBeInTheDocument();
  fireEvent.pointerDown(palette, { button: 0 });
  fireEvent.click(palette);
  fireEvent.pointerUp(window);
  expect(palette).not.toHaveFocus();
  fireEvent.keyDown(window, { key: 's' });
  expect(invoke).toHaveBeenCalledWith('start_capture');
  fireEvent.keyDown(window, { key: 'd' });
  fireEvent.keyDown(window, { key: 'h' });
  expect(container.querySelector('.idle-panel')).toHaveClass('controls-hidden');
});

test('deliberate keyboard navigation still operates the scene menu', () => {
  const { container } = render(<App invoke={() => new Promise(() => {})} />);
  const trigger = screen.getByRole('button', { name: 'Scene' });
  fireEvent.keyDown(container.querySelector('.hud-layout')!, { key: 'Tab' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(screen.getByTestId('scene-select')).toHaveValue('tunnel');
  fireEvent.keyDown(trigger, { key: 'Escape' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
