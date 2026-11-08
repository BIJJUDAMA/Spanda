import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { normalizeRotationInterval, type SceneRotation } from '../experience/rotation';
import { SCENE_OPTIONS } from './ExperienceControls';

export function RotationControls({ rotation }: { rotation: SceneRotation }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(String(rotation.interval));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const helpId = useId();
  const expanded = open && rotation.enabled;
  useEffect(() => setDraft(String(rotation.interval)), [rotation.interval]);
  useEffect(() => {
    const dismiss = () => setOpen(false);
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) dismiss(); };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('dismiss-tooltips', dismiss);
    window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('dismiss-tooltips', dismiss); window.removeEventListener('blur', dismiss); };
  }, []);
  const commit = () => {
    const value = draft.trim() === '' || !Number.isFinite(Number(draft)) ? rotation.interval : normalizeRotationInterval(Number(draft));
    rotation.setInterval(value); setDraft(String(value));
  };
  return <div ref={root} className="rotation-controls control-card"
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    }}>
    <div className="rotation-heading">
      <button type="button" className="rotation-toggle" role="switch" aria-label="Rotate scenes" aria-checked={rotation.enabled}
        onClick={() => { rotation.setEnabled(!rotation.enabled); setOpen(false); }}>
        <span className="rotation-switch-track" aria-hidden="true"><span /></span><span>Rotate scenes</span>
      </button>
      <label className="rotation-interval" data-enabled={rotation.enabled}>
        <span>Every</span><span className="rotation-interval-field">
          <input type="number" autoComplete="off" aria-label="Scene rotation interval in seconds" aria-describedby={helpId}
            min={1} max={3600} step={1} inputMode="numeric" disabled={!rotation.enabled} value={draft}
            onChange={event => setDraft(event.target.value)} onBlur={commit}
            onKeyDown={event => {
              event.stopPropagation();
              if (event.key === 'Enter') { event.preventDefault(); commit(); event.currentTarget.blur(); }
              if (event.key === 'Escape') { event.preventDefault(); setDraft(String(rotation.interval)); }
            }} />
          <span aria-hidden="true">s</span>
        </span>
      </label>
    </div>
    <span id={helpId} className="rotation-input-help">1–3600 seconds. Press Enter or leave the field to apply.</span>
    <button ref={trigger} type="button" className="rotation-picker-trigger" aria-expanded={expanded} aria-controls={panelId}
      disabled={!rotation.enabled} onClick={() => setOpen(!open)}>
      <span>Choose scenes <span className="rotation-count">{rotation.selected.length}</span></span><ChevronDown size={13} aria-hidden="true" />
    </button>
    <div id={panelId} className="rotation-scene-panel" data-open={expanded} aria-hidden={!expanded} inert={!expanded}
      role="group" aria-label="Scenes to rotate"
      onKeyDown={event => {
        const direction = event.key === 'ArrowDown' ? 2 : event.key === 'ArrowUp' ? -2 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!direction && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault(); event.stopPropagation();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      <div className="rotation-panel-heading">Include scenes<span>{rotation.selected.length} selected</span></div>
      <div className="rotation-scene-grid">
        {SCENE_OPTIONS.map(scene => {
          const checked = rotation.selected.includes(scene.value);
          return <button key={scene.value} type="button" role="checkbox" aria-checked={checked} className="rotation-scene-option"
            onClick={() => rotation.setSelected(checked ? rotation.selected.filter(id => id !== scene.value) : [...rotation.selected, scene.value])}>
            <span className="rotation-check" aria-hidden="true"><Check size={11} /></span><span>{scene.label}</span>
          </button>;
        })}
      </div>
      <p className="rotation-panel-note" role="status">{rotation.selected.length < 2 ? 'Choose at least two scenes to rotate.' : 'Changes apply to the next rotation.'}</p>
    </div>
  </div>;
}
