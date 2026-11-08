import { useLayoutEffect, type RefObject } from 'react';

/** Fit natural HUD content inside the actual viewport, including desktop display scaling. */
export function useHudFit(rootRef: RefObject<HTMLDivElement | null>, compact: boolean) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (compact) { root.style.removeProperty('--hud-fit-scale'); return; }
    let pending: number | null = null;
    const fit = () => {
      const parent = root.parentElement;
      if (!parent) return;
      const padding = getComputedStyle(parent);
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const available = Math.max(1, viewport - parseFloat(padding.paddingTop || '0') - parseFloat(padding.paddingBottom || '0'));
      const current = Number(root.style.getPropertyValue('--hud-fit-scale')) || 1;
      const measured = root.getBoundingClientRect().height;
      if (measured <= 0) return;
      const natural = measured / current;
      const next = Math.floor(Math.min(1, available / natural) * 1000) / 1000;
      if (Math.abs(next - current) >= .001) root.style.setProperty('--hud-fit-scale', String(Math.max(.1, next)));
    };
    const schedule = () => {
      if (pending !== null) return;
      pending = requestAnimationFrame(() => { pending = null; fit(); });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(root);
    fit();
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    document.addEventListener('fullscreenchange', schedule);
    return () => {
      observer?.disconnect();
      if (pending !== null) cancelAnimationFrame(pending);
      window.removeEventListener('resize', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
      document.removeEventListener('fullscreenchange', schedule);
      root.style.removeProperty('--hud-fit-scale');
    };
  }, [rootRef, compact]);
}
