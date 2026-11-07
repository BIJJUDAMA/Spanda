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
import {
  ExperienceControls,
  SCENE_OPTIONS,
  PALETTE_OPTIONS,
} from './components/ExperienceControls';
import { DiagnosticsMeter } from './components/DiagnosticsMeter';
import { Tooltip } from './components/ui/tooltip';
import { createSettingsStore, type ExperienceSettings } from './experience/settings';
import { nextControlsVisibility } from './experience/visibility';
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
  const panelRef = useRef<HTMLElement | null>(null);
  const engineRef = useRef<VisualEngine | null>(null);
  const settingsStore = useRef(createSettingsStore());

  const [view, setView] = useState<AudioView>(idleView);
  const [settings, setSettings] = useState<ExperienceSettings>(settingsStore.current.get());
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [controlsVisible, setControlsVisible] = useState<boolean>(true);
  const [focusWithin, setFocusWithin] = useState<boolean>(false);
  const [manuallyHidden, setManuallyHidden] = useState<boolean>(false);

  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [holdDiagnosticsLayout, setHoldDiagnosticsLayout] = useState<boolean>(false);

  const hideControlsTimerRef = useRef<number | null>(null);


  const lastInteractionRef = useRef<number>(Date.now());

  const recordInteraction = useCallback(() => {
    if (hideControlsTimerRef.current !== null) {
      window.clearTimeout(hideControlsTimerRef.current);
      hideControlsTimerRef.current = null;
    }
    lastInteractionRef.current = Date.now();
    setHoldDiagnosticsLayout(false);
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
    if (showDiagnostics) {
      setShowDiagnostics(false);
      setHoldDiagnosticsLayout(true);
      if (hideControlsTimerRef.current !== null) {
        window.clearTimeout(hideControlsTimerRef.current);
      }
      hideControlsTimerRef.current = window.setTimeout(() => {
        setHoldDiagnosticsLayout(false);
        setManuallyHidden(true);
        setControlsVisible(false);
        hideControlsTimerRef.current = null;
      }, 240);
    } else {
      setManuallyHidden(true);
      setControlsVisible(false);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('dismiss-tooltips'));
    }
  }, [showDiagnostics]);

  useEffect(() => () => {
    if (hideControlsTimerRef.current !== null) {
      window.clearTimeout(hideControlsTimerRef.current);
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
    settingsStore.current.set(partial);
    const updated = settingsStore.current.get();
    setSettings(updated);
    if (partial.sceneId && engineRef.current) {
      engineRef.current.setScene(partial.sceneId);
    }
  }, []);

  // Handle Escape key, H key, and mouse interactions
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.key === 'Escape' && isFullscreen) {
        recordInteraction();
        void toggleFullscreen();
        return;
      }

      if (isInput) return;

      if ((e.key === 'h' || e.key === 'H') && !focusWithin) {
        if (!manuallyHidden) {
          handleHideControls();
        } else {
          recordInteraction();
        }
        return;
      }
      if ((e.key === 'd' || e.key === 'D') && !focusWithin) {
        recordInteraction();
        setShowDiagnostics((prev) => !prev);
        return;
      }
      if ((e.key === 's' || e.key === 'S') && !focusWithin) {
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
        const currentSettings = settingsStore.current.get();
        const currentIndex = SCENE_OPTIONS.findIndex((s) => s.value === currentSettings.sceneId);
        const nextIndex = (currentIndex + 1) % SCENE_OPTIONS.length;
        updateSettings({ sceneId: SCENE_OPTIONS[nextIndex].value });
        return;
      }

      if (e.key === 'ArrowLeft') {
        const currentSettings = settingsStore.current.get();
        const currentIndex = SCENE_OPTIONS.findIndex((s) => s.value === currentSettings.sceneId);
        const prevIndex = (currentIndex - 1 + SCENE_OPTIONS.length) % SCENE_OPTIONS.length;
        updateSettings({ sceneId: SCENE_OPTIONS[prevIndex].value });
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const currentSettings = settingsStore.current.get();
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

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('pointerdown', onPointerDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('pointerdown', onPointerDown);
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
      if (showDiagnostics) return;
      if (hideControlsTimerRef.current !== null) return;
      const isVisible = nextControlsVisibility({
        nowMs: Date.now(),
        lastInteractionMs: lastInteractionRef.current,
        focusWithin,
        menuOpen: false,
        hasError: Boolean(view.error || view.clientError),
      });
      if (!isVisible && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('dismiss-tooltips'));
        handleHideControls();
        return;
      }
      setControlsVisible(isVisible);
    }, 100);

    return () => clearInterval(timer);
  }, [focusWithin, manuallyHidden, showDiagnostics, view.error, view.clientError, handleHideControls]);

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
          getSettings: () => settingsStore.current.get(),
          sceneId: settingsStore.current.get().sceneId,
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

      <div className={`hud-layout ${showDiagnostics || holdDiagnosticsLayout ? 'diagnostics-open' : ''}`}>
        <DiagnosticsMeter
          frame={activeFrame}
          source={activeSource}
          view={view}
          isVisible={showDiagnostics}
          onToggle={() => {
            recordInteraction();
            setShowDiagnostics((prev) => !prev);
          }}
        />
        <section
          ref={panelRef}
          className={`idle-panel liquidGlass-wrapper ${showControls ? 'controls-visible' : 'controls-hidden'}`}
          aria-labelledby="app-title"
          aria-hidden={!showControls}
          onFocusCapture={() => setFocusWithin(true)}
          onBlurCapture={() => setFocusWithin(false)}
        >
        <div className="liquidGlass-effect" aria-hidden="true" />
        <div className="liquidGlass-tint" aria-hidden="true" />
        <div className="liquidGlass-shine" aria-hidden="true" />
        <div className="liquidGlass-text main-panel-content">
          <header className="panel-header">
            <div className="brand-lockup">
              <h1 id="app-title">Spanda</h1>
            </div>
            <div className="header-right">
              <Tooltip content="Toggle live audio diagnostics meter" shortcut="D" side="bottom">
                <button
                  type="button"
                  id="toggle-diagnostics"
                  className={`btn btn-minimal ${showDiagnostics ? 'is-selected' : ''}`}
                  onClick={() => {
                    recordInteraction();
                    setShowDiagnostics((prev) => !prev);
                  }}
                >
                  Diagnostics
                </button>
              </Tooltip>
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
            />
          </div>

        </div>
        </section>
      </div>
    </main>
  );
}


