import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Music2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import type { Invoke, Listen } from '../audio/types';
import { Tooltip } from './ui/tooltip';

export interface SpotifyState {
  revision: number;
  sessionId: number;
  available: boolean;
  title: string;
  artist: string;
  album: string;
  artwork: string | null;
  playback: string;
  positionMs: number;
  durationMs: number;
  seekStartMs: number;
  seekEndMs: number;
  canToggle: boolean;
  canPrevious: boolean;
  canNext: boolean;
  canSeek: boolean;
  error: string | null;
}

export function mediaTime(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function SpotifyPlayer({ invoke, listen, onAttentionChange }: { invoke: Invoke; listen: Listen; onAttentionChange?: (needsAttention: boolean) => void }) {
  const [state, setState] = useState<SpotifyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [hoverTime, setHoverTime] = useState<{ position: number; ratio: number } | null>(null);
  const [seekPreview, setSeekPreview] = useState<{ sessionId: number; position: number; revision: number } | null>(null);
  const seekRef = useRef<typeof seekPreview>(null);
  const [draft, setDraft] = useState<{ sessionId: number; position: number } | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const current = useRef<SpotifyState | null>(null);
  const needsAttention = pending || seekPreview !== null || Boolean(error || state?.error);

  useEffect(() => {
    onAttentionChange?.(needsAttention);
    return () => onAttentionChange?.(false);
  }, [needsAttention, onAttentionChange]);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let unlisten: (() => void) | undefined;
    const accept = (next: SpotifyState) => {
      if (!active || !next || typeof next.revision !== 'number') return;
      if (current.current && next.revision < current.current.revision) return;
      if (next.sessionId !== current.current?.sessionId || next.title !== current.current?.title || next.artist !== current.current?.artist) {
        setDraft(null);
        setHoverTime(null);
        seekRef.current = null;
        setSeekPreview(null);
        setNotice('');
        setError(null);
      }
      const target = seekRef.current;
      if (target && next.revision > target.revision && Math.abs(next.positionMs - target.position) < 2000) {
        seekRef.current = null;
        setSeekPreview(null);
        setNotice('');
      } else if (!target && next.revision > (current.current?.revision ?? 0)) {
        setNotice('');
      }
      current.current = next;
      setState(next);
      setError(previous => previous === 'Spotify controls unavailable' ? null : previous);
    };
    const refresh = () => invoke('get_spotify_state').then(value => accept(value as SpotifyState))
      .catch(() => {
        if (active) {
          current.current = null;
          setState(null);
          setDraft(null);
          seekRef.current = null;
          setSeekPreview(null);
          setNotice('');
          setError('Spotify controls unavailable');
        }
      });
    // Listen before fetching so a late snapshot cannot overwrite a newer event.
    void Promise.resolve().then(() => listen<SpotifyState>('spotify_state', event => accept(event.payload)))
      .then(dispose => { if (active) unlisten = dispose; else dispose(); })
      .catch(() => { /* Periodic snapshots also support event transport failures. */ })
      .finally(() => { if (active) void refresh(); });
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      mounted.current = false;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [invoke, listen]);

  useEffect(() => {
    if (!seekPreview) return;
    const timer = window.setTimeout(() => {
      seekRef.current = null;
      setSeekPreview(null);
      setNotice('');
      setError('Spotify did not confirm the seek. Try again.');
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [seekPreview]);

  const command = async (action: 'toggle' | 'previous' | 'next' | 'seek', positionMs?: number) => {
    const session = current.current;
    if (!session?.available || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setNotice(action === 'toggle' ? (session.playback === 'playing' ? 'Pausing Spotify…' : 'Starting Spotify playback…')
      : action === 'next' ? 'Requesting next track…' : action === 'previous' ? 'Requesting previous track…' : `Seeking to ${mediaTime(positionMs ?? 0)}…`);
    if (action === 'seek' && positionMs !== undefined) {
      const target = { sessionId: session.sessionId, position: positionMs, revision: session.revision };
      seekRef.current = target;
      setSeekPreview(target);
    }
    try {
      await invoke('control_spotify', { sessionId: session.sessionId, action, positionMs });
      if (mounted.current && current.current?.sessionId === session.sessionId) {
        setNotice(action === 'seek' && seekRef.current ? `Seeking to ${mediaTime(positionMs ?? 0)}…` : 'Request sent to Spotify');
      }
    } catch (reason) {
      if (mounted.current && current.current?.sessionId === session.sessionId) {
        setError(String(reason));
        setNotice('');
        if (action === 'seek') { seekRef.current = null; setSeekPreview(null); }
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const commitSeek = () => {
    if (draft && draft.sessionId === current.current?.sessionId) void command('seek', draft.position);
    setDraft(null);
  };
  const available = state?.available === true;
  const playing = state?.playback === 'playing';
  const position = draft?.sessionId === state?.sessionId ? draft?.position ?? 0
    : seekPreview?.sessionId === state?.sessionId ? seekPreview?.position ?? 0 : state?.positionMs ?? 0;
  const seekable = available && state.canSeek && !pending;
  const rangeMin = state?.canSeek ? state.seekStartMs : 0;
  const rangeMax = state?.canSeek ? state.seekEndMs : Math.max(1, state?.durationMs ?? 0);
  const rangeValue = Math.min(rangeMax, Math.max(rangeMin, position));
  const progress = rangeMax > rangeMin ? ((rangeValue - rangeMin) / (rangeMax - rangeMin)) * 100 : 0;
  return (
    <section className="spotify-player" aria-label="Spotify player" aria-busy={pending}>
      <div className="spotify-track">
        <div className="spotify-artwork" aria-hidden="true">
          {available && state.artwork ? <img src={state.artwork} alt="" /> : <Music2 size={22} />}
        </div>
        <div className="spotify-metadata">
          <span className="spotify-status">Spotify · {available ? state.playback : 'unavailable'}</span>
          <strong title={state?.title}>{available ? state.title || 'Untitled track' : 'Spotify unavailable'}</strong>
          <span title={available ? [state.artist, state.album].filter(Boolean).join(' · ') : undefined}>
            {available ? [state.artist || 'Unknown artist', state.album].filter(Boolean).join(' · ') : 'Open the Spotify desktop app to connect'}
          </span>
        </div>
        <div className="spotify-buttons">
          <Tooltip content={!available ? 'Open Spotify desktop to use playback controls' : !state.canPrevious ? 'Spotify has no previous track available' : 'Play the previous Spotify track'}>
          <button type="button" className="btn btn-icon" aria-label="Previous Spotify track" disabled={!available || !state.canPrevious || pending} onClick={() => void command('previous')}><SkipBack size={17} /></button>
          </Tooltip>
          <Tooltip content={!available ? 'Open Spotify desktop to use playback controls' : !state.canToggle ? 'Spotify cannot change playback right now' : playing ? 'Pause Spotify; capture stays active' : 'Play Spotify; capture stays as it is'}>
          <button type="button" className="btn btn-icon" aria-label={playing ? 'Pause Spotify' : 'Play Spotify'} disabled={!available || !state.canToggle || pending} onClick={() => void command('toggle')}>{playing ? <Pause size={19} /> : <Play size={19} />}</button>
          </Tooltip>
          <Tooltip content={!available ? 'Open Spotify desktop to use playback controls' : !state.canNext ? 'Spotify has no next track available' : 'Play the next Spotify track'}>
          <button type="button" className="btn btn-icon" aria-label="Next Spotify track" disabled={!available || !state.canNext || pending} onClick={() => void command('next')}><SkipForward size={17} /></button>
          </Tooltip>
        </div>
      </div>
      {available && <div className="spotify-timeline">
        <span>{mediaTime(position)}</span>
        <div className="spotify-seek-control" onPointerLeave={() => setHoverTime(null)}>
        {hoverTime && seekable && <span className="spotify-seek-preview" data-testid="seek-time-preview" aria-hidden="true"
          style={{ left: `clamp(1.75rem, ${hoverTime.ratio * 100}%, calc(100% - 1.75rem))` }}>{mediaTime(hoverTime.position)}</span>}
        <input type="range" aria-label="Spotify playback position" aria-valuetext={`${mediaTime(position)} of ${mediaTime(state.durationMs)}`}
          aria-description={state.canSeek ? 'Hover to preview; drag and release to seek' : 'Spotify does not allow seeking in this track'}
          min={rangeMin} max={rangeMax}
          step={1000} value={rangeValue}
          style={{ '--spotify-progress': `${progress}%` } as CSSProperties}
          disabled={!seekable}
          onPointerMove={event => {
            if (!seekable || event.pointerType === 'touch') { setHoverTime(null); return; }
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width <= 16) return;
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left - 8) / (rect.width - 16)));
            const target = Math.min(rangeMax, Math.max(rangeMin, Math.round((rangeMin + ratio * (rangeMax - rangeMin)) / 1000) * 1000));
            setHoverTime({ position: target, ratio });
          }}
          onChange={event => setDraft({ sessionId: state.sessionId, position: Number(event.target.value) })}
          onPointerUp={commitSeek} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitSeek(); }}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(null); } }}
          onPointerCancel={() => { setDraft(null); setHoverTime(null); }} onBlur={() => { setDraft(null); setHoverTime(null); }} />
        </div>
        <span>{mediaTime(state.durationMs)}</span>
      </div>}
      <p className="spotify-action-status" aria-live="polite" aria-atomic="true">{draft ? `Release to seek to ${mediaTime(draft.position)}` : notice}</p>
      {(error || state?.error) && <p className="spotify-error" role="status">{error || state?.error}</p>}
    </section>
  );
}
