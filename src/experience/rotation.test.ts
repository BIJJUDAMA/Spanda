import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { nextRotationScene, useSceneRotation } from './rotation';
afterEach(() => vi.useRealTimers());
it('requires two unique scenes and wraps around the chosen sequence', () => {
  expect(nextRotationScene(['a', 'a'], 'a')).toBeNull();
  expect(nextRotationScene(['a', 'b', 'c'], 'c')).toBe('a');
  expect(nextRotationScene(['a', 'b'], 'other')).toBe('a');
});
it('rotates only when enabled and resets the timer after manual selection', () => {
  vi.useFakeTimers(); const change = vi.fn();
  const { result, rerender, unmount } = renderHook(({ current }) => useSceneRotation(current, change, ['a', 'b', 'c']), { initialProps: { current: 'a' } });
  act(() => vi.advanceTimersByTime(60000)); expect(change).not.toHaveBeenCalled();
  act(() => result.current.setEnabled(true));
  act(() => vi.advanceTimersByTime(20000)); rerender({ current: 'c' });
  act(() => vi.advanceTimersByTime(10000)); expect(change).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(20000)); expect(change).toHaveBeenCalledWith('a');
  unmount(); act(() => vi.advanceTimersByTime(60000)); expect(change).toHaveBeenCalledTimes(1);
});

it('accepts a custom seven-second interval without the old ten-second floor', () => {
  vi.useFakeTimers(); const change = vi.fn();
  const { result } = renderHook(() => useSceneRotation('a', change, ['a', 'b']));
  act(() => { result.current.setInterval(7); result.current.setEnabled(true); });
  act(() => vi.advanceTimersByTime(6999)); expect(change).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1)); expect(change).toHaveBeenCalledWith('b');
});
