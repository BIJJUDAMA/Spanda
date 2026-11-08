import { defaultSettings, type VisualSettings } from '../visualizers/types';
import { SCENE_OPTIONS } from '../visualizers/catalog';

export interface ExperienceSettings extends VisualSettings {
  sceneId: string;
}
export const VISUAL_SETTINGS_KEY = 'spanda.visual-settings.v1';
export const initialExperienceSettings: ExperienceSettings = {
  ...defaultSettings,
  sceneId: 'oscilloscope',
};

function validated(value: unknown, fallback: ExperienceSettings): ExperienceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
  const input = value as Record<string, unknown>;
  const settings = { ...fallback };
  if (SCENE_OPTIONS.some(scene => scene.value === input.sceneId)) settings.sceneId = input.sceneId as string;
  if (['aurora', 'ember', 'cosmic', 'cyberpunk', 'synthwave', 'matrix', 'monochrome'].includes(input.palette as string)) settings.palette = input.palette as VisualSettings['palette'];
  if (['punchy', 'smooth', 'hyper', 'liquid', 'bouncy'].includes(input.response as string)) settings.response = input.response as VisualSettings['response'];
  if (['low', 'medium', 'high'].includes(input.quality as string)) settings.quality = input.quality as VisualSettings['quality'];
  if (typeof input.sensitivity === 'number' && Number.isFinite(input.sensitivity)) settings.sensitivity = Math.min(2, Math.max(.25, input.sensitivity));
  if (typeof input.typographyText === 'string') settings.typographyText = input.typographyText.slice(0, 48);
  return settings;
}

function restoredSettings(): ExperienceSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(VISUAL_SETTINGS_KEY) ?? 'null');
    if (stored?.version === 1) return validated(stored.settings, initialExperienceSettings);
  } catch { /* Unavailable or damaged storage uses the defaults. */ }
  return { ...initialExperienceSettings };
}

export function createSettingsStore(initial?: ExperienceSettings) {
  let settings = initial ? validated(initial, initialExperienceSettings) : restoredSettings();
  const listeners = new Set<() => void>();
  return {
    get: () => settings,
    set: (partial: Partial<ExperienceSettings>) => {
      settings = validated(partial, settings);
      try { localStorage.setItem(VISUAL_SETTINGS_KEY, JSON.stringify({ version: 1, settings })); }
      catch { /* Settings still work for this session when storage is unavailable. */ }
      listeners.forEach(fn => fn());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
export type SettingsStore = ReturnType<typeof createSettingsStore>;
