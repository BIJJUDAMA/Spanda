import type { Palette, Quality, ResponseStyle } from '../visualizers/types';
import type { ExperienceSettings } from '../experience/settings';
import { CustomSelect } from './ui/custom-select';
import { Tooltip } from './ui/tooltip';
import { SensitivitySlider } from './SensitivitySlider';

export interface ExperienceControlsProps {
  settings: ExperienceSettings;
  onUpdate: (partial: Partial<ExperienceSettings>) => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onHideControls: () => void;
}

export const SCENE_OPTIONS = [
  { value: 'oscilloscope', label: 'Oscilloscope' },
  { value: 'tunnel', label: 'Geometric Tunnel' },
  { value: 'bars', label: 'Spectrum Bars' },
  { value: 'particle-sphere', label: 'Particle Sphere' },
];



export const PALETTE_OPTIONS: { value: Palette; label: string; colors: [string, string, string] }[] = [
  { value: 'aurora', label: 'Aurora', colors: ['#19e573', '#1ab3e6', '#a94be8'] },
  { value: 'ember', label: 'Ember', colors: ['#e6472e', '#ff8b17', '#ffd543'] },
  { value: 'cosmic', label: 'Cosmic', colors: ['#2878f5', '#8c42d9', '#ef4eac'] },
  { value: 'cyberpunk', label: 'Cyberpunk', colors: ['#ff22a5', '#00f5ff', '#ffea00'] },
  { value: 'synthwave', label: 'Synthwave', colors: ['#7a26e0', '#ff598f', '#20e6d5'] },
  { value: 'matrix', label: 'Matrix', colors: ['#00df5d', '#42e68b', '#c3ef33'] },
  { value: 'monochrome', label: 'Monochrome', colors: ['#bbc4d3', '#778196', '#f3f7ff'] },
];

const RESPONSE_OPTIONS: { value: ResponseStyle; label: string; detail: string }[] = [
  { value: 'punchy', label: 'Punch', detail: 'Bass-led, crisp hits' },
  { value: 'smooth', label: 'Smooth', detail: 'Soft, slow movement' },
  { value: 'hyper', label: 'Hyper', detail: 'Fast, energetic peaks' },
  { value: 'liquid', label: 'Liquid', detail: 'Flowing, sustained motion' },
  { value: 'bouncy', label: 'Bounce', detail: 'Elastic rhythmic motion' },
];

const QUALITY_OPTIONS: { value: Quality; label: string; detail: string }[] = [
  { value: 'low', label: 'Low', detail: '50% render scale' },
  { value: 'medium', label: 'Balanced', detail: '75% render scale' },
  { value: 'high', label: 'High', detail: 'Full render scale' },
];

export function ExperienceControls({
  settings,
  onUpdate,
  isFullscreen,
  onToggleFullscreen,
  onHideControls,
}: ExperienceControlsProps) {
  return (
    <div className="experience-controls-container" role="group" aria-label="Visual experience controls">
      <div className="experience-fields">
        <div className="scene-control control-card"><Tooltip content="Change scene" shortcut="← / →" className="scene-shortcut-hint">
          <label htmlFor="scene-select">Scene</label>
          <CustomSelect
            id="scene-select"
            ariaLabel="Scene selector"
            value={settings.sceneId}
            options={SCENE_OPTIONS}
            onChange={(val) => onUpdate({ sceneId: val })}
          />
          </Tooltip>
        </div>

        <fieldset className="palette-control control-card">
          <legend>Palette</legend>
          <div className="palette-swatches" role="group" aria-label="Color palette">
            {PALETTE_OPTIONS.map((option) => (
              <Tooltip key={option.value} content={option.label} shortcut="↑ / ↓" side="top">
                <button
                  type="button"
                  className={`palette-swatch ${settings.palette === option.value ? 'is-selected' : ''}`}
                  style={{ '--palette-colors': option.colors.join(', ') } as React.CSSProperties}
                  aria-label={`Palette ${option.label}`}
                  aria-pressed={settings.palette === option.value}
                  data-testid={`palette-${option.value}`}
                  onClick={() => onUpdate({ palette: option.value })}
                >
                  <span className="palette-swatch-gradient" aria-hidden="true" />
                  <span className="palette-swatch-name">{option.label}</span>
                </button>
              </Tooltip>
            ))}
          </div>
        </fieldset>

        <fieldset className="response-control control-card">
          <legend>Dynamics</legend>
          <div className="choice-grid response-grid" role="group" aria-label="Dynamics response">
            {RESPONSE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`choice-button ${settings.response === option.value ? 'is-selected' : ''}`}
                aria-label={`${option.label}: ${option.detail}`}
                aria-pressed={settings.response === option.value}
                onClick={() => onUpdate({ response: option.value })}
              >
                <span>{option.label}</span>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="quality-control control-card">
          <legend>Render quality</legend>
          <div className="choice-grid quality-grid" role="group" aria-label="Render quality">
            {QUALITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`choice-button quality-choice ${settings.quality === option.value ? 'is-selected' : ''}`}
                aria-label={`${option.label}, ${option.detail}`}
                aria-pressed={settings.quality === option.value}
                onClick={() => onUpdate({ quality: option.value })}
              >
                <span>{option.label}</span>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="sensitivity-control control-card">
          <div className="sensitivity-heading">
            <label htmlFor="sensitivity-range">Sensitivity</label>
            <button type="button" className="sensitivity-reset" aria-label="Reset sensitivity to 1.00×"
              title="Double-click to reset to 1.00×; press Enter when focused"
              onDoubleClick={() => onUpdate({ sensitivity: 1 })}
              onClick={event => { if (event.detail === 0) onUpdate({ sensitivity: 1 }); }}>
              {settings.sensitivity.toFixed(2)}×
            </button>
          </div>
          <SensitivitySlider
            value={settings.sensitivity}
            onChange={(sensitivity) => onUpdate({ sensitivity })}
          />
          <div className="sensitivity-scale" aria-hidden="true">
            <span>Gentle</span><span>1× balanced</span><span>Strong</span>
          </div>
        </div>
      </div>

      <div className="experience-actions">
        <Tooltip
          content={isFullscreen ? 'Exit full screen view' : 'Enter full screen visualization'}
          shortcut={isFullscreen ? 'Esc / F / F11' : 'F / F11'}
          side="top"
        >
          <button
            type="button"
            className="btn action-btn fullscreen-button"
            aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
            onClick={onToggleFullscreen}
          >
            {isFullscreen ? 'Exit Full Screen (Esc)' : 'Enter Full Screen'}
          </button>
        </Tooltip>

        <Tooltip content="Hide controls panel until mouse is moved" shortcut="H" side="top">
          <button
            type="button"
            className="btn action-btn hide-controls-button"
            aria-label="Hide controls until mouse is moved"
            onClick={onHideControls}
          >
            Hide Controls (H)
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
