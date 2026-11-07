import { defaultSettings, type VisualSettings } from '../visualizers/types';

export interface ExperienceSettings extends VisualSettings {
  sceneId: string;
}

export const initialExperienceSettings: ExperienceSettings = {
  ...defaultSettings,
  sceneId: 'oscilloscope',
};

export function createSettingsStore(initial: ExperienceSettings = initialExperienceSettings) {
  let settings: ExperienceSettings = { ...initial };
  const listeners = new Set<() => void>();

  return {
    get: () => settings,
    set: (partial: Partial<ExperienceSettings>) => {
      settings = {
        ...settings,
        ...partial,
        sensitivity:
          partial.sensitivity !== undefined
            ? Number.isFinite(partial.sensitivity)
              ? Math.min(2.0, Math.max(0.25, partial.sensitivity))
              : settings.sensitivity
            : settings.sensitivity,
      };
      listeners.forEach((fn) => fn());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
