import { afterEach, expect, it, vi } from 'vitest';
import { createSettingsStore, initialExperienceSettings, VISUAL_SETTINGS_KEY } from './settings';
afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(VISUAL_SETTINGS_KEY); });
it('restores the visual settings in a new store', () => {
  const first = createSettingsStore();
  first.set({ sceneId: 'kaleidoscope', palette: 'ember', sensitivity: 1.35, response: 'liquid', quality: 'high', typographyText: 'Hello' });
  expect(createSettingsStore().get()).toEqual(first.get());
  expect(JSON.parse(localStorage.getItem(VISUAL_SETTINGS_KEY)!)).toEqual({ version: 1, settings: first.get() });
});
it('recovers defaults from damaged, unknown-version and invalid stored values', () => {
  for (const data of ['broken json', 'null', '{"version":2}', '{"version":1,"settings":[]}']) {
    localStorage.setItem(VISUAL_SETTINGS_KEY, data); expect(createSettingsStore().get()).toEqual(initialExperienceSettings);
  }
  localStorage.setItem(VISUAL_SETTINGS_KEY, JSON.stringify({ version: 1, settings: { sceneId: 'removed-scene', palette: 'invalid', sensitivity: 500, quality: null, response: 'invalid', typographyText: 'x'.repeat(80) } }));
  expect(createSettingsStore().get()).toEqual({ ...initialExperienceSettings, sensitivity: 2, typographyText: 'x'.repeat(48) });
});
it('validates individual fields without losing valid stored choices', () => {
  localStorage.setItem(VISUAL_SETTINGS_KEY, JSON.stringify({ version: 1, settings: { sceneId: 'kaleidoscope', palette: 'cosmic', sensitivity: '1.5', response: 'smooth' } }));
  expect(createSettingsStore().get()).toMatchObject({ sceneId: 'kaleidoscope', palette: 'cosmic', sensitivity: 1, response: 'smooth' });
  const store = createSettingsStore(); store.set({ sensitivity: NaN }); expect(store.get().sensitivity).toBe(1);
  store.set({ sensitivity: -100 }); expect(store.get().sensitivity).toBe(.25);
});
it('continues updating and notifying when browser storage is denied', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
  const store = createSettingsStore(); const notify = vi.fn(), unsubscribe = store.subscribe(notify);
  store.set({ sceneId: 'kaleidoscope' }); expect(store.get().sceneId).toBe('kaleidoscope'); expect(notify).toHaveBeenCalledOnce();
  unsubscribe(); store.set({ palette: 'ember' }); expect(notify).toHaveBeenCalledOnce();
});

it.each(['terrain-waves', 'spectrogram-waterfall'])('falls back from removed scene %s while preserving other preferences', sceneId => {
  localStorage.setItem(VISUAL_SETTINGS_KEY, JSON.stringify({ version: 1, settings: { sceneId, palette: 'ember', sensitivity: 1.4 } }));
  expect(createSettingsStore().get()).toMatchObject({ sceneId: 'oscilloscope', palette: 'ember', sensitivity: 1.4 });
});
