import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useSelectedHudTab } from './selected-tab';

const key = 'spanda.hud.selected-tab';
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('restores the selected tab after remounting', () => {
  const first = renderHook(useSelectedHudTab);
  expect(first.result.current[0]).toBe('visuals');
  act(() => first.result.current[1]('spotify'));
  expect(localStorage.getItem(key)).toBe('spotify');
  first.unmount();
  const reopened = renderHook(useSelectedHudTab);
  expect(reopened.result.current[0]).toBe('spotify');
});

it('ignores invalid stored tabs', () => {
  localStorage.setItem(key, 'unknown');
  const { result } = renderHook(useSelectedHudTab);
  expect(result.current[0]).toBe('visuals');
});

it('keeps working when storage access is denied', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
  const { result } = renderHook(useSelectedHudTab);
  act(() => result.current[1]('diagnostics'));
  expect(result.current[0]).toBe('diagnostics');
});
