import { useRef } from 'react';

const MIN = 0.25;
const CENTER = 1;
const MAX = 2;
const STEP = 0.05;
const GLIDE_DURATION_MS = 360;
const GLIDE_EASING = 'cubic-bezier(0.23, 1, 0.32, 1)';
const DRAG_START_THRESHOLD_PX = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function quantize(value: number): number {
  return Number((MIN + Math.round((clamp(value, MIN, MAX) - MIN) / STEP) * STEP).toFixed(2));
}

// Give the 1× reference an exact midpoint while retaining the existing 0.25×–2× range.
function valueToProgress(value: number): number {
  return value <= CENTER
    ? 0.5 * ((value - MIN) / (CENTER - MIN))
    : 0.5 + 0.5 * ((value - CENTER) / (MAX - CENTER));
}

function progressToValue(progress: number): number {
  const bounded = clamp(progress, 0, 1);
  return quantize(bounded <= 0.5
    ? MIN + (bounded / 0.5) * (CENTER - MIN)
    : CENTER + ((bounded - 0.5) / 0.5) * (MAX - CENTER));
}

interface SensitivitySliderProps {
  value: number;
  onChange: (value: number) => void;
}

export function SensitivitySlider({ value, onChange }: SensitivitySliderProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    offsetX: number;
    startX: number;
    isDragging: boolean;
  } | null>(null);
  const currentValue = quantize(value);
  const progress = valueToProgress(currentValue);

  const applyPointerValue = (clientX: number, offsetX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const travel = Math.max(0, rect.width - 16);
    if (travel <= 0) return;
    onChange(progressToValue((clientX - rect.left - 8 - offsetX) / travel));
  };

  const animateToProgress = (targetProgress: number, trackWidth: number) => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const thumb = thumbRef.current;
    const fill = fillRef.current;
    const travel = Math.max(0, trackWidth - 16);
    if (!thumb || !fill || travel <= 0) return;

    const rect = trackRef.current?.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const from = rect ? clamp((thumbRect.left + thumbRect.width / 2 - rect.left - 8) / travel, 0, 1) : progress;
    const fillRect = fill.getBoundingClientRect();
    const fromFill = rect ? clamp(fillRect.width / rect.width, 0, 1) : progress;
    thumb.getAnimations().forEach((animation) => animation.cancel());
    fill.getAnimations().forEach((animation) => animation.cancel());
    const options: KeyframeAnimationOptions = { duration: GLIDE_DURATION_MS, fill: 'none', easing: GLIDE_EASING };
    thumb.animate(
      [
        { transform: `translateX(calc(-50% + ${(from - 0.5) * travel}px)) translateY(-50%)` },
        { transform: `translateX(calc(-50% + ${(targetProgress - 0.5) * travel}px)) translateY(-50%)` },
      ],
      options
    );
    fill.animate(
      [
        { transform: `translateY(-50%) scaleX(${fromFill})` },
        { transform: `translateY(-50%) scaleX(${targetProgress})` },
      ],
      options
    );
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const track = event.currentTarget;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    event.preventDefault();
    track.focus();
    const thumb = thumbRef.current;
    const clickedThumb = Boolean(thumb && (event.target === thumb || thumb.contains(event.target as Node)));
    const travel = Math.max(0, rect.width - 16);
    const thumbCenter = rect.left + 8 + progress * travel;
    const offsetX = clickedThumb ? event.clientX - thumbCenter : 0;
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX,
      startX: event.clientX,
      isDragging: clickedThumb,
    };
    track.setPointerCapture?.(event.pointerId);

    if (clickedThumb) {
      thumb?.getAnimations().forEach((animation) => animation.cancel());
      fillRef.current?.getAnimations().forEach((animation) => animation.cancel());
    } else {
      const targetProgress = valueToProgress(progressToValue((event.clientX - rect.left - 8) / travel));
      animateToProgress(targetProgress, rect.width);
    }
    applyPointerValue(event.clientX, offsetX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.isDragging) {
      if (Math.abs(event.clientX - drag.startX) < DRAG_START_THRESHOLD_PX) return;
      drag.isDragging = true;
    }
    thumbRef.current?.getAnimations().forEach((animation) => animation.cancel());
    fillRef.current?.getAnimations().forEach((animation) => animation.cancel());
    applyPointerValue(event.clientX, drag.offsetX);
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = currentValue + STEP;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = currentValue - STEP;
    if (event.key === 'PageUp') next = currentValue + 0.25;
    if (event.key === 'PageDown') next = currentValue - 0.25;
    if (event.key === 'Home') next = MIN;
    if (event.key === 'End') next = MAX;
    if (next !== undefined) {
      event.preventDefault();
      onChange(quantize(next));
    }
  };
  const thumbOffset = (progress - 0.5) * Math.max(0, (trackRef.current?.clientWidth ?? 16) - 16);

  return (
    <div
      ref={trackRef}
      className="sensitivity-slider"
      role="slider"
      tabIndex={0}
      aria-label="Sensitivity"
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuenow={currentValue}
      aria-valuetext={`${currentValue.toFixed(2)}×`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onKeyDown={handleKeyDown}
    >
      <span className="sensitivity-slider-track" aria-hidden="true" />
      <span
        ref={fillRef}
        className="sensitivity-slider-fill"
        style={{ transform: `translateY(-50%) scaleX(${progress})` }}
        aria-hidden="true"
      />
      <span
        ref={thumbRef}
        className="sensitivity-slider-thumb"
        style={{ transform: `translateX(calc(-50% + ${thumbOffset}px)) translateY(-50%)` }}
        aria-hidden="true"
      />
    </div>
  );
}
