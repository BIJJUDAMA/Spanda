import { useLayoutEffect, useRef, type RefObject } from 'react';

const timing = { duration: 600, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' };

/** Animate the shell from its currently displayed size, including interrupted transitions. */
export function useTabMotion(rootRef: RefObject<HTMLDivElement | null>, compact: boolean, selection: string) {
  const pending = useRef<number | null>(null);
  const animations = useRef<Animation[]>([]);
  const ghost = useRef<HTMLElement | null>(null);
  const clear = () => {
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
    ghost.current?.remove();
    ghost.current = null;
    if (rootRef.current) rootRef.current.style.overflow = '';
  };

  const prepare = () => {
    const root = rootRef.current;
    if (!compact || !root?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const height = root.getBoundingClientRect().height;
    const displayedPanel = root.querySelector<HTMLElement>(':scope > [role="tabpanel"]:not([hidden])');
    const displayedOpacity = displayedPanel ? getComputedStyle(displayedPanel).opacity : '1';
    clear();
    pending.current = height;
    const panel = root.querySelector<HTMLElement>(':scope > [role="tabpanel"]:not([hidden])');
    if (!panel) return;
    const clone = panel.cloneNode(true) as HTMLElement;
    const bounds = panel.getBoundingClientRect();
    const shell = root.getBoundingClientRect();
    clone.removeAttribute('id');
    clone.removeAttribute('role');
    clone.removeAttribute('aria-labelledby');
    clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    clone.setAttribute('aria-hidden', 'true');
    clone.inert = true;
    clone.style.opacity = displayedOpacity;
    const canvases = panel.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((canvas, index) => {
      const source = canvases[index];
      if (source) canvas.getContext('2d')?.drawImage(source, 0, 0);
    });
    Object.assign(clone.style, {
      position: 'absolute', top: `${bounds.top - shell.top}px`, left: `${bounds.left - shell.left}px`,
      width: `${bounds.width}px`, height: `${bounds.height}px`, margin: '0',
      pointerEvents: 'none', zIndex: '20', overflow: 'hidden',
    });
    root.appendChild(clone);
    ghost.current = clone;
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    const previousHeight = pending.current;
    pending.current = null;
    if (!compact || !root || previousHeight === null) { clear(); return; }
    const targetHeight = root.getBoundingClientRect().height;
    root.style.overflow = 'clip';
    const resize = root.animate([{ height: `${previousHeight}px` }, { height: `${targetHeight}px` }], timing);
    resize.onfinish = () => { root.style.overflow = ''; };
    animations.current.push(resize);
    const panel = root.querySelector<HTMLElement>(':scope > [role="tabpanel"]:not([hidden])');
    if (panel) animations.current.push(panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 360, easing: 'ease-out' }));
    const outgoing = ghost.current;
    if (outgoing) {
      const fade = outgoing.animate([{ opacity: outgoing.style.opacity || '1' }, { opacity: 0 }], { duration: 180, easing: 'ease-out' });
      fade.onfinish = () => { outgoing.remove(); if (ghost.current === outgoing) ghost.current = null; };
      animations.current.push(fade);
    }
  }, [compact, selection]);

  useLayoutEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reset = () => { pending.current = null; clear(); };
    window.addEventListener('resize', reset);
    reduced?.addEventListener('change', reset);
    return () => { window.removeEventListener('resize', reset); reduced?.removeEventListener('change', reset); clear(); };
  }, []);
  return prepare;
}
