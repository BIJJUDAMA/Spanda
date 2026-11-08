import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke as desktopInvoke } from '@tauri-apps/api/core';
import { listen as desktopListen } from '@tauri-apps/api/event';
import { createAudioClient, type AudioClient } from './audio/client';
import {
  idleView,
  defaultAnalysisFrame,
  type AudioView,
  type Invoke,
  type Listen,
} from './audio/types';
import { CaptureControls } from './CaptureControls';
import { SpotifyPlayer } from './components/SpotifyPlayer';
import banner from '../assets/banner.png';
import {
  ExperienceControls,
  SCENE_OPTIONS,
  PALETTE_OPTIONS,
} from './components/ExperienceControls';
import { DiagnosticsMeter } from './components/DiagnosticsMeter';
import { createSettingsStore, type ExperienceSettings } from './experience/settings';
import { nextControlsVisibility } from './experience/visibility';
import { useCompactHud } from './experience/compact';
import { useHudFit } from './experience/hud-fit';
import { useTabMotion } from './experience/tab-motion';
import { VisualEngine } from './visualizers/engine';
import type { Palette } from './visualizers/types';

export default function App({
  invoke = desktopInvoke,
  listen = desktopListen as Listen,
}: {
  invoke?: Invoke;
  listen?: Listen;
}) {
  const client = useRef<AudioClient | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<VisualEngine | null>(null);
  const [settingsStore] = useState(() => createSettingsStore());

  const [view, setView] = useState<AudioView>(idleView);
  const [settings, setSettings] = useState<ExperienceSettings>(settingsStore.get());
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [controlsVisible, setControlsVisible] = useState<boolean>(true);
  const [focusWithin, setFocusWithin] = useState<boolean>(false);
  const [pointerWithin, setPointerWithin] = useState(false);
  const [pointerActive, setPointerActive] = useState(false);
  const [mediaNeedsAttention, setMediaNeedsAttention] = useState(false);
  const [manuallyHidden, setManuallyHidden] = useState<boolean>(false);
  const compact = useCompactHud();
  useHudFit(panelRef, compact);
  const [compactPanel, setCompactPanel] = useState<'visuals' | 'spotify' | 'diagnostics'>('visuals');
  const prepareTabMotion = useTabMotion(panelRef, compact, compactPanel);
  const selectCompactPanel = (panel: typeof compactPanel) => {
    if (panel === compactPanel) return;
    prepareTabMotion();
    setCompactPanel(panel);
  };

  const lastInteractionRef = useRef<number>(Date.now());

  const recordInteraction = useCallback(() => {
    lastInteractionRef.current = Date.now();
    setManuallyHidden(false);
    setControlsVisible(true);
    if (engineRef.current && !engineRef.current.isRunning && !engineRef.current.isContextLost) {
      engineRef.current.start();
    }
  }, []);

  const handleHideControls = useCallback(() => {
    if (typeof document !== 'undefined') {
      (document.activeElement as HTMLElement)?.blur();
    }
    setFocusWithin(false);
    setManuallyHidden(true);
    setControlsVisible(false);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dismiss-tooltips'));
    }
  }, []);

  const toggleFullscreen = useCallback(async () => {
    recordInteraction();
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const current = await win.isFullscreen();
        await win.setFullscreen(!current);
        setIsFullscreen(!current);
        return;
      }
    } catch {
      // Fallback to standard web Fullscreen API
    }
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch?.(() => {});
      setIsFullscreen(true);
    } else {
      void document.exitFullscreen?.().catch?.(() => {});
      setIsFullscreen(false);
    }
  }, [recordInteraction]);

  const updateSettings = useCallback((partial: Partial<ExperienceSettings>) => {
    settingsStore.set(partial);
    const updated = settingsStore.get();
    setSettings(updated);
    if (partial.sceneId && engineRef.current) {
      engineRef.current.setScene(partial.sceneId);
    }
  }, []);

  // Handle Escape key, H key, and mouse interactions
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable ||
          target.closest('[role="slider"], [role="listbox"], [role="tablist"], [aria-haspopup="listbox"]'));

      if (e.key === 'Escape' && isFullscreen) {
        recordInteraction();
        void toggleFullscreen();
        return;
      }

      if (isInput) return;

      if (e.key === 'h' || e.key === 'H') {
        if (!manuallyHidden) {
          handleHideControls();
        } else {
          recordInteraction();
        }
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        recordInteraction();
        const isCapturing = ['starting', 'running', 'recovering'].includes(view.state);
        if (isCapturing) {
          void client.current?.stop().catch(() => {});
        } else {
          void client.current?.start().catch(() => {});
        }
        return;
      }

      if (e.key === 'ArrowRight') {
        const currentSettings = settingsStore.get();
        const currentIndex = SCENE_OPTIONS.findIndex((s) => s.value === currentSettings.sceneId);
        const nextIndex = (currentIndex + 1) % SCENE_OPTIONS.length;
        updateSettings({ sceneId: SCENE_OPTIONS[nextIndex].value });
        return;
      }

      if (e.key === 'ArrowLeft') {
        const currentSettings = settingsStore.get();
        const currentIndex = SCENE_OPTIONS.findIndex((s) => s.value === currentSettings.sceneId);
        const prevIndex = (currentIndex - 1 + SCENE_OPTIONS.length) % SCENE_OPTIONS.length;
        updateSettings({ sceneId: SCENE_OPTIONS[prevIndex].value });
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const currentSettings = settingsStore.get();
        const currentIndex = PALETTE_OPTIONS.findIndex((p) => p.value === currentSettings.palette);
        const direction = e.key === 'ArrowUp' ? 1 : -1;
        const nextIndex = (currentIndex + direction + PALETTE_OPTIONS.length) % PALETTE_OPTIONS.length;
        updateSettings({ palette: PALETTE_OPTIONS[nextIndex].value as Palette });
        return;
      }

      if (e.key === 'f' || e.key === 'F' || e.key === 'F11') {
        e.preventDefault();
        recordInteraction();
        void toggleFullscreen();
        return;
      }

      recordInteraction();
    };
    const onMouseMove = () => recordInteraction();
    const onPointerDown = () => recordInteraction();
    const onPointerEnd = () => {
      setPointerActive(false);
      lastInteractionRef.current = Date.now();
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && panelRef.current?.contains(focused)
          && focused.matches('button, input[type="range"], [role="slider"]')) focused.blur();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [
    focusWithin,
    isFullscreen,
    manuallyHidden,
    handleHideControls,
    recordInteraction,
    toggleFullscreen,
    view.state,
    updateSettings,
  ]);

  // Idle visibility timer
  useEffect(() => {
    const timer = setInterval(() => {
      if (manuallyHidden) return;
      const isVisible = nextControlsVisibility({
        nowMs: Date.now(),
        lastInteractionMs: lastInteractionRef.current,
        focusWithin: focusWithin || pointerWithin || pointerActive || view.pending,
        menuOpen: false,
        hasError: Boolean(view.error || view.clientError || mediaNeedsAttention),
      });
      if (!isVisible && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dismiss-tooltips'));
        handleHideControls();
        return;
      }
      setControlsVisible(isVisible);
    }, 100);

    return () => clearInterval(timer);
  }, [focusWithin, pointerWithin, pointerActive, view.pending, mediaNeedsAttention, manuallyHidden, view.error, view.clientError, handleHideControls]);

  // Audio and Visual Engine Initialization
  useEffect(() => {
    const audio = createAudioClient(invoke, listen);
    client.current = audio;
    const unsubscribe = audio.subscribe(() => setView(audio.getSnapshot()));
    setView(audio.getSnapshot());

    if (containerRef.current) {
      try {
        const engine = new VisualEngine({
          container: containerRef.current,
          readAudio: (nowMs) => audio.readAudio(nowMs),
          getSettings: () => settingsStore.get(),
          sceneId: settingsStore.get().sceneId,
        });
        engine.start();
        engineRef.current = engine;

        const handleResize = () => engine.resize();
        window.addEventListener('resize', handleResize);

        requestAnimationFrame(() => {
          engine.resize();
        });

        return () => {
          window.removeEventListener('resize', handleResize);
          engine.dispose();
          engineRef.current = null;
          unsubscribe();
          audio.dispose();
          client.current = null;
        };
      } catch (err) {
        if (process.env.NODE_ENV !== 'test') {
          console.error('Failed to initialize visual engine:', err);
        }
      }
    }

    return () => {
      unsubscribe();
      audio.dispose();
      client.current = null;
    };
  }, [invoke]);

  const showControls = !manuallyHidden && (controlsVisible || view.state !== 'running');

  useEffect(() => {
    document.documentElement.classList.toggle('cursor-hidden', !showControls);
    return () => document.documentElement.classList.remove('cursor-hidden');
  }, [showControls]);

  const activeSource = view.source;
  const activeFrame = view.analysis ?? defaultAnalysisFrame;

  return (
    <main className="app">
      <div ref={containerRef} className="visualizer-container" data-testid="visualizer-container" />


      <div className={`hud-layout ${showControls ? 'controls-visible' : 'controls-hidden'}`}
        data-compact={compact}
        ref={panelRef}
        aria-hidden={!showControls}
        inert={!showControls}
        onFocusCapture={() => setFocusWithin(true)}
        onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false); }}
        onPointerEnter={() => { setPointerWithin(true); recordInteraction(); }}
        onPointerLeave={() => { setPointerWithin(false); lastInteractionRef.current = Date.now(); }}
        onPointerDownCapture={(event) => {
          setPointerActive(true);
          event.currentTarget.dataset.inputModality = 'pointer';
          const focused = document.activeElement;
          if (focused instanceof HTMLElement && event.currentTarget.contains(focused)) focused.blur();
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest('button, [role="slider"], [role="option"]')) event.preventDefault();
        }}
        onKeyDownCapture={(event) => { if (event.key === 'Tab') event.currentTarget.dataset.inputModality = 'keyboard'; }}>
        {compact && <nav className="hud-compact-tabs" role="tablist" aria-label="HUD panels"
          onKeyDown={event => {
            const panels = ['visuals', 'spotify', 'diagnostics'] as const;
            const index = panels.indexOf(compactPanel);
            const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3
              : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
            if (next < 0) return;
            event.preventDefault(); event.stopPropagation();
            selectCompactPanel(panels[next]);
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
          }}>
          <span className="hud-tab-indicator" aria-hidden="true" style={{ transform: `translateX(calc(${['visuals', 'spotify', 'diagnostics'].indexOf(compactPanel)} * (100% + .25rem)))` }} />
            {(['visuals', 'spotify', 'diagnostics'] as const).map(panel => <button key={panel} type="button" role="tab"
            id={`hud-tab-${panel}`} aria-selected={compactPanel === panel} tabIndex={compactPanel === panel ? 0 : -1}
            aria-controls={panel === 'visuals' ? 'hud-visuals-panel' : 'diagnostics-panel'}
            onClick={() => { selectCompactPanel(panel); recordInteraction(); }}>{panel === 'visuals' ? 'Visuals' : panel === 'spotify' ? 'Spotify' : 'Diagnostics'}</button>)}
        </nav>}
        <DiagnosticsMeter
          frame={activeFrame}
          source={activeSource}
          view={view}
          isVisible={showControls && (!compact || compactPanel === 'diagnostics')}
          mode={!compact ? 'full' : compactPanel === 'spotify' ? 'player' : 'diagnostics'}
          hidden={compact && compactPanel === 'visuals'}
        >
          <SpotifyPlayer invoke={invoke} listen={listen} onAttentionChange={setMediaNeedsAttention} />
        </DiagnosticsMeter>
        <section
          id="hud-visuals-panel"
          role={compact ? 'tabpanel' : undefined}
          hidden={compact && compactPanel !== 'visuals'}
          className={`idle-panel liquidGlass-wrapper ${showControls ? 'controls-visible' : 'controls-hidden'}`}
          aria-labelledby={compact ? 'hud-tab-visuals' : 'app-title'}
          aria-hidden={!showControls}
          inert={!showControls}
        >
        <div className="liquidGlass-effect" aria-hidden="true" />
        <div className="liquidGlass-tint" aria-hidden="true" />
        <div className="liquidGlass-shine" aria-hidden="true" />
        <div className="liquidGlass-text main-panel-content">
          <header className="panel-header">
            <div className="brand-lockup">
              <h1 id="app-title"><img className="hud-brand-banner" src={banner} alt="Spanda" draggable={false} /></h1>
            </div>
          </header>

          <div className="panel-body-grid">
            <CaptureControls
              view={view}
              client={client.current}
            />
            <ExperienceControls
              settings={settings}
              onUpdate={updateSettings}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
              onHideControls={handleHideControls}
              compact={compact}
            />

          </div>

        </div>
        </section>
      </div>
    </main>
  );
}
