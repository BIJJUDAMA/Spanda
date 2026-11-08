import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RotationControls } from './RotationControls';
import { useSceneRotation } from '../experience/rotation';
import { SCENE_OPTIONS } from './ExperienceControls';
function Harness() {
  const rotation = useSceneRotation('oscilloscope', () => {}, SCENE_OPTIONS.map(scene => scene.value));
  return <RotationControls rotation={rotation} />;
}
afterEach(() => vi.useRealTimers());
it('uses custom controls and commits custom seconds without a native dropdown', () => {
  const { container } = render(<Harness />);
  expect(container.querySelector('select')).toBeNull();
  const interval = screen.getByRole('spinbutton', { name: 'Scene rotation interval in seconds' });
  expect(interval).toBeDisabled();
  fireEvent.click(screen.getByRole('switch', { name: 'Rotate scenes' }));
  fireEvent.change(interval, { target: { value: '7' } }); fireEvent.keyDown(interval, { key: 'Enter' });
  expect(interval).toHaveValue(7);
  fireEvent.change(interval, { target: { value: '9999' } }); fireEvent.blur(interval);
  expect(interval).toHaveValue(3600);
  fireEvent.change(interval, { target: { value: '' } }); fireEvent.blur(interval);
  expect(interval).toHaveValue(3600);
});
it('Escape discards interval edits without changing the applied value', () => {
  render(<Harness />); fireEvent.click(screen.getByRole('switch'));
  const interval = screen.getByRole('spinbutton'); interval.focus();
  fireEvent.change(interval, { target: { value: '45' } }); fireEvent.keyDown(interval, { key: 'Escape' });
  expect(interval).toHaveValue(30); fireEvent.blur(interval); expect(interval).toHaveValue(30);
});
it('keeps outgoing panels mounted but inert, and handles rapid switching, keyboard and outside dismissal', () => {
  render(<Harness />); fireEvent.click(screen.getByRole('switch'));
  const trigger = screen.getByRole('button', { name: /Choose scenes/ });
  fireEvent.click(trigger);
  const panel = screen.getByRole('group', { name: 'Scenes to rotate' });
  expect(panel).toHaveAttribute('data-open', 'true');
  const first = screen.getByRole('checkbox', { name: 'Oscilloscope' });
  fireEvent.click(first); expect(first).toHaveAttribute('aria-checked', 'false');
  act(() => first.focus()); fireEvent.keyDown(first, { key: 'ArrowRight' });
  expect(screen.getByRole('checkbox', { name: 'Geometric Tunnel' })).toHaveFocus();
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(trigger).toHaveFocus(); expect(panel).toHaveAttribute('inert');
  expect(panel).toHaveAttribute('data-open', 'false'); expect(panel).toBeInTheDocument();
  fireEvent.click(trigger); fireEvent.click(trigger); fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  fireEvent.pointerDown(document.body); expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
