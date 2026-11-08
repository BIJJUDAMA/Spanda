import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useHudFit } from './hud-fit';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });
function fixture() {
  const parent = document.createElement('main'), root = document.createElement('div');
  parent.style.padding = '24px'; parent.append(root); document.body.append(parent);
  let naturalHeight = 1000;
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ height: naturalHeight * (Number(root.style.getPropertyValue('--hud-fit-scale')) || 1) }) as DOMRect);
  const queued: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { queued.push(callback); return queued.length; });
  const flush = () => act(() => { while (queued.length) queued.shift()!(0); });
  let resized: (() => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('visualViewport', undefined); vi.stubGlobal('innerHeight', 900);
  return { root, flush, resizeContent: (height: number) => { naturalHeight = height; resized?.(); }, disconnect };
}
it('fits the whole desktop HUD inside the viewport padding without cumulative shrinking', () => {
  const { root, flush, resizeContent } = fixture();
  const ref = { current: root }; renderHook(() => useHudFit(ref, false));
  expect(root.getBoundingClientRect().height).toBeLessThanOrEqual(852);
  expect(root.style.getPropertyValue('--hud-fit-scale')).toBe('0.852');
  for (let i = 0; i < 5; i++) { resizeContent(1000); flush(); }
  expect(root.style.getPropertyValue('--hud-fit-scale')).toBe('0.852');
  resizeContent(1200); flush(); expect(root.getBoundingClientRect().height).toBeLessThanOrEqual(852);
});
it('restores full size when fullscreen has sufficient height', () => {
  const { root, flush } = fixture(), ref = { current: root };
  renderHook(() => useHudFit(ref, false));
  vi.stubGlobal('innerHeight', 1200);
  act(() => document.dispatchEvent(new Event('fullscreenchange'))); flush();
  expect(root.style.getPropertyValue('--hud-fit-scale')).toBe('1');
});
it('leaves compact sizing alone and disconnects observers on layout changes', () => {
  const { root, disconnect } = fixture(), ref = { current: root };
  const { rerender, unmount } = renderHook(({ compact }) => useHudFit(ref, compact), { initialProps: { compact: false } });
  rerender({ compact: true });
  expect(root.style.getPropertyValue('--hud-fit-scale')).toBe(''); expect(disconnect).toHaveBeenCalledOnce();
  unmount();
});
