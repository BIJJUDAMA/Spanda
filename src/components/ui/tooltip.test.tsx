import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Tooltip } from './tooltip';

describe('Tooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders trigger element without showing tooltip initially', () => {
    render(
      <Tooltip content="Helpful information" shortcut="S">
        <button type="button">Test Trigger</button>
      </Tooltip>
    );

    expect(screen.getByRole('button', { name: 'Test Trigger' })).toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('reveals tooltip with content and shortcut after delay on hover', () => {
    render(
      <Tooltip content="Start live capture" shortcut="S" delay={150}>
        <button type="button">Start</button>
      </Tooltip>
    );

    const triggerWrap = screen.getByRole('button', { name: 'Start' }).parentElement!;
    fireEvent.mouseEnter(triggerWrap);

    // Before delay expires, not yet visible
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // After delay expires, tooltip appears
    act(() => {
      vi.advanceTimersByTime(60);
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('Start live capture');
    expect(tooltip).toHaveTextContent('S');
    expect(tooltip).toHaveClass('is-entering');
  });

  it('dismisses tooltip smoothly when mouse leaves', async () => {
    render(
      <Tooltip content="Help message" delay={50}>
        <button type="button">Button</button>
      </Tooltip>
    );

    const triggerWrap = screen.getByRole('button', { name: 'Button' }).parentElement!;
    fireEvent.mouseEnter(triggerWrap);

    act(() => {
      vi.advanceTimersByTime(60);
    });
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeInTheDocument();

    // Mouse leaves
    fireEvent.mouseLeave(triggerWrap);
    expect(tooltip).toHaveClass('is-leaving');

    // After fade-out animation completes
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses immediately on click', () => {
    render(
      <Tooltip content="Clickable action" delay={50}>
        <button type="button">Click Me</button>
      </Tooltip>
    );

    const triggerWrap = screen.getByRole('button', { name: 'Click Me' }).parentElement!;
    fireEvent.mouseEnter(triggerWrap);

    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.click(triggerWrap);
    expect(screen.getByRole('tooltip')).toHaveClass('is-leaving');
  });

  it('does not display when disabled', () => {
    render(
      <Tooltip content="Disabled info" disabled delay={50}>
        <button type="button">Disabled Tooltip</button>
      </Tooltip>
    );

    const triggerWrap = screen.getByRole('button', { name: 'Disabled Tooltip' }).parentElement!;
    fireEvent.mouseEnter(triggerWrap);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('uses 800ms default delay when no delay prop is passed', () => {
    render(
      <Tooltip content="Default delay message">
        <button type="button">Default Delay</button>
      </Tooltip>
    );

    const triggerWrap = screen.getByRole('button', { name: 'Default Delay' }).parentElement!;
    fireEvent.mouseEnter(triggerWrap);

    // At 750ms, not yet visible
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // At 850ms, visible
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('dismisses immediately on dismiss-tooltips custom event', () => {
    render(
      <Tooltip content="Dismiss me" delay={50}>
        <button type="button">Dismiss Target</button>
      </Tooltip>
    );

    const triggerWrap = screen.getByRole('button', { name: 'Dismiss Target' }).parentElement!;
    fireEvent.mouseEnter(triggerWrap);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent('dismiss-tooltips'));
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses immediately on H or Escape key press to eliminate orphan tooltips', () => {
    render(
      <Tooltip content="Dismiss on H" delay={50}>
        <button type="button">Key Target</button>
      </Tooltip>
    );

    const triggerWrap = screen.getByRole('button', { name: 'Key Target' }).parentElement!;
    fireEvent.mouseEnter(triggerWrap);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'h' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('does not display when inside a hidden HUD (.controls-hidden)', () => {
    render(
      <div className="controls-hidden">
        <Tooltip content="Hidden container info" delay={50}>
          <button type="button">Inside Hidden</button>
        </Tooltip>
      </div>
    );

    const triggerWrap = screen.getByRole('button', { name: 'Inside Hidden' }).parentElement!;
    fireEvent.mouseEnter(triggerWrap);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
