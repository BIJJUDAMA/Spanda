import { useEffect, useState } from 'react';
export function normalizeRotationInterval(seconds: number): number {
  return Number.isFinite(seconds) ? Math.min(3600, Math.max(1, Math.round(seconds))) : 30;
}
export function nextRotationScene(selected: string[], current: string): string | null {
  const unique = [...new Set(selected)];
  return unique.length < 2 ? null : unique[(unique.indexOf(current) + 1) % unique.length];
}
export function useSceneRotation(current: string, onScene: (id: string) => void, available: string[]) {
  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalValue] = useState(30);
  const setInterval = (seconds: number) => setIntervalValue(normalizeRotationInterval(seconds));
  const [selected, setSelected] = useState(available);
  useEffect(() => {
    if (!enabled) return;
    const next = nextRotationScene(selected, current);
    if (!next) return;
    const timer = window.setTimeout(() => onScene(next), normalizeRotationInterval(interval) * 1000);
    return () => window.clearTimeout(timer);
  }, [enabled, interval, selected, current, onScene]);
  return { enabled, setEnabled, interval, setInterval, selected, setSelected };
}
export type SceneRotation = ReturnType<typeof useSceneRotation>;
