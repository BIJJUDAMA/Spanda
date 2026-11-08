import { useEffect, useState } from 'react';

export type HudTab = 'visuals' | 'spotify' | 'diagnostics';
const key = 'spanda.hud.selected-tab';

export function useSelectedHudTab() {
  const [tab, setTab] = useState<HudTab>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === 'spotify' || saved === 'diagnostics' ? saved : 'visuals';
    } catch { return 'visuals'; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, tab); } catch { /* Keep controls usable when storage is unavailable. */ }
  }, [tab]);
  return [tab, setTab] as const;
}
