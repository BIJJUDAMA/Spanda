import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTabMotion } from './tab-motion';

const originalAnimate = Element.prototype.animate;
afterEach(() => { vi.restoreAllMocks(); if (originalAnimate) Element.prototype.animate = originalAnimate; else Reflect.deleteProperty(Element.prototype, 'animate'); document.body.innerHTML = ''; });

it('retargets from the displayed height and removes snapshots on resize and unmount', () => {
  const root = document.createElement('div');
  root.innerHTML = '<section role="tabpanel" id="panel"><button id="control">Play</button></section>';
  document.body.append(root);
  let height = 500;
  vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => ({ height, top: 0, left: 0 }) as DOMRect);
  const calls: { frames: Keyframe[]; animation: Animation }[] = [];
  Element.prototype.animate = vi.fn((frames) => {
    const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
    calls.push({ frames: frames as Keyframe[], animation });
    return animation;
  });
  const { result, rerender, unmount } = renderHook(({ selection }) => useTabMotion({ current: root }, true, selection), { initialProps: { selection: 'visuals' } });
  act(() => result.current());
  expect(root.querySelectorAll('#control')).toHaveLength(1);
  expect(root.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
  height = 250;
  rerender({ selection: 'spotify' });
  expect(calls[0].frames).toEqual([{ height: '500px' }, { height: '250px' }]);
  height = 390;
  act(() => result.current());
  height = 460;
  rerender({ selection: 'diagnostics' });
  expect(calls[3].frames).toEqual([{ height: '390px' }, { height: '460px' }]);
  act(() => window.dispatchEvent(new Event('resize')));
  expect(root.children).toHaveLength(1);
  expect(root.style.overflow).toBe('');
  unmount();
  expect(calls.every(call => vi.mocked(call.animation.cancel).mock.calls.length > 0)).toBe(true);
});
