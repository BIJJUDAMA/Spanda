import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { nextControlsVisibility } from './visibility';
import { ExperienceControls } from '../components/ExperienceControls';
import { initialExperienceSettings } from './settings';
import { SensitivitySlider } from '../components/SensitivitySlider';

describe('nextControlsVisibility', () => {
  it('hides after 1000 ms idle, but stays visible on focus, menu, or error', () => {
    // Within 1000 ms: visible
    expect(
      nextControlsVisibility({
        nowMs: 750,
        lastInteractionMs: 0,
        focusWithin: false,
        menuOpen: false,
        hasError: false,
      })
    ).toBe(true);

    // After 1000 ms idle: hidden
    expect(
      nextControlsVisibility({
        nowMs: 1250,
        lastInteractionMs: 0,
        focusWithin: false,
        menuOpen: false,
        hasError: false,
      })
    ).toBe(false);

    // After 1000 ms idle, but focusWithin is true: remains visible
    expect(
      nextControlsVisibility({
        nowMs: 1500,
        lastInteractionMs: 0,
        focusWithin: true,
        menuOpen: false,
        hasError: false,
      })
    ).toBe(true);

    // After 1000 ms idle, but menuOpen is true: remains visible
    expect(
      nextControlsVisibility({
        nowMs: 1500,
        lastInteractionMs: 0,
        focusWithin: false,
        menuOpen: true,
        hasError: false,
      })
    ).toBe(true);

    // After 1000 ms idle, but hasError is true: remains visible
    expect(
      nextControlsVisibility({
        nowMs: 1500,
        lastInteractionMs: 0,
        focusWithin: false,
        menuOpen: false,
        hasError: true,
      })
    ).toBe(true);
  });
});

describe('ExperienceControls component', () => {
  it('renders all controls with accessible labels and triggers updates', () => {
    const onUpdate = vi.fn();
    const onToggleFullscreen = vi.fn();
    const onHideControls = vi.fn();

    render(
      <ExperienceControls
        settings={initialExperienceSettings}
        onUpdate={onUpdate}
        isFullscreen={false}
        onToggleFullscreen={onToggleFullscreen}
        onHideControls={onHideControls}
      />
    );

    // Scene selector
    const sceneSelect = screen.getByLabelText('Scene selector');
    expect(sceneSelect).toBeInTheDocument();
    fireEvent.change(sceneSelect, { target: { value: 'bars' } });
    expect(onUpdate).toHaveBeenCalledWith({ sceneId: 'bars' });

    // Palette selector
    fireEvent.click(screen.getByRole('button', { name: 'Palette Cosmic' }));
    expect(onUpdate).toHaveBeenCalledWith({ palette: 'cosmic' });

    fireEvent.click(screen.getByRole('button', { name: /Smooth: Soft, slow movement/ }));
    expect(onUpdate).toHaveBeenCalledWith({ response: 'smooth' });

    fireEvent.click(screen.getByRole('button', { name: /Balanced, 75% render scale/ }));
    expect(onUpdate).toHaveBeenCalledWith({ quality: 'medium' });

    // Sensitivity slider
    const sensitivityRange = screen.getByLabelText('Sensitivity');
    fireEvent.keyDown(sensitivityRange, { key: 'ArrowRight' });
    expect(onUpdate).toHaveBeenCalledWith({ sensitivity: 1.05 });
    fireEvent.keyDown(sensitivityRange, { key: 'ArrowLeft' });
    expect(onUpdate).toHaveBeenCalledWith({ sensitivity: 0.95 });
    expect(sensitivityRange).toHaveAttribute('aria-valuemin', '0.25');
    expect(sensitivityRange).toHaveAttribute('aria-valuemax', '2');
    expect(sensitivityRange).toHaveAttribute('aria-valuenow', '1');

    // Full-screen button
    const fsButton = screen.getByRole('button', { name: 'Enter full screen' });
    fireEvent.click(fsButton);
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);

    // Hide controls button
    const hideButton = screen.getByRole('button', { name: 'Hide controls until mouse is moved' });
    expect(hideButton).toBeInTheDocument();
    fireEvent.click(hideButton);
    expect(onHideControls).toHaveBeenCalledTimes(1);
  });
});

describe('SensitivitySlider pointer interaction', () => {
  it('double-click resets the slider to 1.00 and cancels outstanding animation', () => {
    const cancel = vi.fn();
    const onChange = vi.fn();
    const { container } = render(<SensitivitySlider value={1.6} onChange={onChange} />);
    for (const part of container.querySelectorAll('.sensitivity-slider-thumb, .sensitivity-slider-fill')) {
      Object.defineProperty(part, 'getAnimations', { value: () => [{ cancel }] });
    }
    fireEvent.doubleClick(screen.getByRole('slider'));
    expect(onChange).toHaveBeenCalledWith(1);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('keyboard input interrupts any outstanding thumb and fill glide', () => {
    const cancel = vi.fn();
    const onChange = vi.fn();
    const { container } = render(<SensitivitySlider value={1} onChange={onChange} />);
    for (const part of container.querySelectorAll('.sensitivity-slider-thumb, .sensitivity-slider-fill')) {
      Object.defineProperty(part, 'getAnimations', { value: () => [{ cancel }] });
    }
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledWith(1.05);
  });
  it('animates track clicks with a spring and keeps pointer dragging direct', () => {
    const onChange = vi.fn();
    const { container } = render(<SensitivitySlider value={1} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Sensitivity' });
    Object.defineProperty(slider, 'getBoundingClientRect', {
      value: () => ({ left: 0, right: 200, top: 0, bottom: 20, width: 200, height: 20, x: 0, y: 0, toJSON: () => ({}) }),
    });
    const thumb = container.querySelector('.sensitivity-slider-thumb')!;
    const fill = container.querySelector('.sensitivity-slider-fill')!;
    const animate = vi.fn(() => ({ cancel: vi.fn() }));
    Object.defineProperty(thumb, 'getBoundingClientRect', {
      value: () => ({ left: 92, right: 108, top: 2, bottom: 18, width: 16, height: 16, x: 92, y: 2, toJSON: () => ({}) }),
    });
    Object.defineProperty(thumb, 'animate', { value: animate });
    Object.defineProperty(fill, 'animate', { value: animate });
    Object.defineProperty(thumb, 'getAnimations', { value: () => [] });
    Object.defineProperty(fill, 'getAnimations', { value: () => [] });

    fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 146 });
    expect(onChange).toHaveBeenLastCalledWith(1.5);
    expect(animate).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ transform: expect.stringContaining('translateX') }),
    ]), expect.objectContaining({ duration: 360, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }));

    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 148 });
    expect(onChange).toHaveBeenCalledTimes(2);
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 150 });
    expect(onChange).toHaveBeenLastCalledWith(1.55);
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 100 });
    expect(onChange).toHaveBeenLastCalledWith(1);
    fireEvent.pointerUp(slider, { pointerId: 1 });
  });
});

it('double-clicking the sensitivity value resets it, with keyboard activation available', () => {
  const onUpdate = vi.fn();
  render(<ExperienceControls settings={{ ...initialExperienceSettings, sensitivity: 1.6 }} onUpdate={onUpdate}
    isFullscreen={false} onToggleFullscreen={vi.fn()} onHideControls={vi.fn()} />);
  const reset = screen.getByRole('button', { name: 'Reset sensitivity to 1.00×' });
  fireEvent.click(reset, { detail: 1 });
  expect(onUpdate).not.toHaveBeenCalled();
  fireEvent.doubleClick(reset);
  expect(onUpdate).toHaveBeenLastCalledWith({ sensitivity: 1 });
  onUpdate.mockClear();
  fireEvent.click(reset, { detail: 0 });
  expect(onUpdate).toHaveBeenCalledWith({ sensitivity: 1 });
});
