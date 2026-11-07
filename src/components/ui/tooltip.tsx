import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

export interface TooltipProps {
  content: React.ReactNode;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Tooltip({
  content,
  shortcut,
  side = 'top',
  delay = 800,
  disabled = false,
  className,
  children,
}: TooltipProps) {
  const [mounted, setMounted] = useState(false);
  const [animState, setAnimState] = useState<'entering' | 'leaving'>('entering');
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const tooltipId = useId();

  const isTriggerActiveAndVisible = useCallback(() => {
    if (!triggerRef.current) return false;
    // If inside a hidden HUD or hidden parent container, trigger is not visible
    if (triggerRef.current.closest('.controls-hidden')) return false;
    if (typeof window !== 'undefined' && 'getComputedStyle' in window) {
      const style = window.getComputedStyle(triggerRef.current);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
    }
    return true;
  }, []);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !tooltipRef.current) return;
    if (!isTriggerActiveAndVisible()) {
      dismissImmediately();
      return;
    }

    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();
    const offset = 5;

    let top = 0;
    let left = 0;

    if (side === 'top') {
      top = triggerRect.top - tooltipRect.height - offset;
      left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
      if (top < 8) {
        top = triggerRect.bottom + offset;
      }
    } else if (side === 'bottom') {
      top = triggerRect.bottom + offset;
      left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;
      if (top + tooltipRect.height > window.innerHeight - 8) {
        top = triggerRect.top - tooltipRect.height - offset;
      }
    } else if (side === 'left') {
      top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
      left = triggerRect.left - tooltipRect.width - offset;
      if (left < 8) {
        left = triggerRect.right + offset;
      }
    } else if (side === 'right') {
      top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;
      left = triggerRect.right + offset;
      if (left + tooltipRect.width > window.innerWidth - 8) {
        left = triggerRect.left - tooltipRect.width - offset;
      }
    }

    const padding = 8;
    left = Math.max(padding, Math.min(left, window.innerWidth - tooltipRect.width - padding));

    setCoords({ top, left });
  }, [side, isTriggerActiveAndVisible]);

  const dismissImmediately = useCallback(() => {
    if (showTimerRef.current) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setMounted(false);
  }, []);

  const handleOpen = useCallback(() => {
    if (disabled || !content) return;
    if (!isTriggerActiveAndVisible()) return;

    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    showTimerRef.current = window.setTimeout(() => {
      // Re-verify trigger is still active before mounting
      if (isTriggerActiveAndVisible()) {
        setMounted(true);
        setAnimState('entering');
      } else {
        dismissImmediately();
      }
    }, delay);
  }, [disabled, content, delay, isTriggerActiveAndVisible, dismissImmediately]);

  const handleClose = useCallback(() => {
    if (showTimerRef.current) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (mounted) {
      setAnimState('leaving');
      hideTimerRef.current = window.setTimeout(() => {
        setMounted(false);
      }, 140); // Matches tooltipFadeOut animation duration
    }
  }, [mounted]);

  // Recalculate position when mounted or when scrolling/resizing
  // and listen for global dismissal events to eliminate orphan tooltips
  useEffect(() => {
    if (mounted) {
      updatePosition();

      const onScrollOrResize = () => updatePosition();
      const onGlobalDismiss = () => dismissImmediately();
      const onWindowBlur = () => dismissImmediately();

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape' || e.key === 'h' || e.key === 'H') {
          dismissImmediately();
        }
      };

      const onPointerDown = (e: PointerEvent) => {
        if (triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
          dismissImmediately();
        }
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!triggerRef.current || !isTriggerActiveAndVisible()) {
          dismissImmediately();
          return;
        }
        const rect = triggerRef.current.getBoundingClientRect();
        // If cursor moved outside trigger bounds, initiate smooth exit
        if (
          e.clientX < rect.left ||
          e.clientX > rect.right ||
          e.clientY < rect.top ||
          e.clientY > rect.bottom
        ) {
          handleClose();
        }
      };

      window.addEventListener('scroll', onScrollOrResize, true);
      window.addEventListener('resize', onScrollOrResize);
      window.addEventListener('dismiss-tooltips', onGlobalDismiss);
      window.addEventListener('blur', onWindowBlur);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('mousemove', onMouseMove, { passive: true });

      return () => {
        window.removeEventListener('scroll', onScrollOrResize, true);
        window.removeEventListener('resize', onScrollOrResize);
        window.removeEventListener('dismiss-tooltips', onGlobalDismiss);
        window.removeEventListener('blur', onWindowBlur);
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('mousemove', onMouseMove);
      };
    }
  }, [mounted, updatePosition, dismissImmediately, handleClose, isTriggerActiveAndVisible]);

  useEffect(() => {
    return () => {
      if (showTimerRef.current) window.clearTimeout(showTimerRef.current);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  return (
    <span
      ref={triggerRef}
      className={cn('tooltip-wrapper', className)}
      onMouseEnter={handleOpen}
      onMouseLeave={handleClose}
      onFocusCapture={handleOpen}
      onBlurCapture={handleClose}
      onClickCapture={handleClose}
      aria-describedby={mounted ? tooltipId : undefined}
    >
      {children}
      {mounted &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            className={cn('ui-tooltip', `is-${animState}`)}
            style={{
              top: `${coords.top}px`,
              left: `${coords.left}px`,
            }}
          >
            <span>{content}</span>
            {shortcut && <kbd className="tooltip-kbd">{shortcut}</kbd>}
          </div>,
          document.body
        )}
    </span>
  );
}
