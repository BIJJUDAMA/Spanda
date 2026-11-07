import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { expect, test, vi } from 'vitest';
import App from './App';
import { idleAnalysis, idleSnapshot, type Invoke } from './audio/types';

test('remount stays idle without invoking Start', async () => {
  const invoke = vi.fn<Invoke>(() => Promise.resolve(idleSnapshot as never));
  const view = render(<StrictMode><App invoke={invoke} /></StrictMode>);
  expect(screen.getByRole('button', { name: /^Start$/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  // Open diagnostics to check status
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  expect(within(screen.getByTestId('diagnostics-meter')).getByRole('status')).toHaveTextContent(/^Idle$/);
  view.unmount();
  render(<App invoke={invoke} />);
  await act(async () => {});
  expect(invoke.mock.calls.every(([command]) => command === 'get_snapshot')).toBe(true);
});

test('Start invokes once while pending, errors visible and retry available', async () => {
  let reject!: (reason: unknown) => void;
  const invoke = vi.fn<Invoke>((command) => command === 'start_capture' ? new Promise((_, r) => { reject = r; }) : Promise.resolve(idleSnapshot as never));
  render(<App invoke={invoke} />);
  const start = screen.getByRole('button', { name: /^Start$/ });
  fireEvent.click(start);
  fireEvent.click(start);
  expect(start).toBeDisabled();
  expect(invoke.mock.calls.filter(([c]) => c === 'start_capture')).toHaveLength(1);
  await act(async () => reject({ code: 'open', message: 'Choose a Windows output and retry.' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a Windows output and retry.');
  expect(start).toBeEnabled();
});

test('Stop clears levels after command completion', async () => {
  const invoke: Invoke = <T,>(command: string) => Promise.resolve((command === 'get_snapshot' ? { ...idleSnapshot, generation: 1, sequence: 1, state: 'running', analysis: { ...idleAnalysis, rms: 0.5, peak: 1 }, silent: false } : undefined) as T);
  render(<App invoke={invoke} />);
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  await waitFor(() => expect(screen.getByLabelText('Peak')).toHaveTextContent('1.0000'));
  fireEvent.click(screen.getByRole('button', { name: /^Stop/ }));
  await waitFor(() => expect(screen.getByLabelText('Peak')).toHaveTextContent('0.0000'));
  expect(within(screen.getByTestId('diagnostics-meter')).getByRole('status')).toHaveTextContent('Idle');
});

test('recovery remains stoppable and explains automatic retry', async () => {
  const invoke: Invoke = <T,>() => Promise.resolve({ ...idleSnapshot, generation: 1, sequence: 1, state: 'recovering' } as T);
  render(<App invoke={invoke} />);
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  const diagnostics = screen.getByTestId('diagnostics-meter');
  await waitFor(() => expect(within(diagnostics).getByRole('status')).toHaveTextContent('Recovering'));
  expect(screen.getByRole('button', { name: /^Stop/ })).toBeEnabled();
  expect(document.querySelector('.capture-start-button')).toBeDisabled();
  expect(screen.getByText(/retrying automatically/i)).toBeInTheDocument();
});

test('displays live capture telemetry without a redundant source pill', async () => {
  let resolveSnapshot!: (snap: any) => void;
  const invoke: Invoke = <T,>(command: string) => {
    if (command === 'get_snapshot') {
      return new Promise<T>((r) => {
        resolveSnapshot = r;
      });
    }
    return Promise.resolve(undefined as T);
  };

  render(<App invoke={invoke} />);
  // Main UI should NOT display source badge
  expect(screen.queryByTestId('diagnostics-source-badge')).not.toBeInTheDocument();

  // Open diagnostics to see source badge
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  expect(screen.queryByTestId('diagnostics-source-badge')).not.toBeInTheDocument();
  expect(within(screen.getByTestId('diagnostics-meter')).getByRole('status')).toHaveTextContent('Idle');

  await act(async () => {
    resolveSnapshot({
      ...idleSnapshot,
      generation: 1,
      sequence: 1,
      state: 'running',
      deviceName: 'Realtek Audio',
      analysis: { ...idleAnalysis, rms: 0.4, peak: 0.8 },
      silent: false,
    });
  });

  await waitFor(() => {
    expect(within(screen.getByTestId('diagnostics-meter')).getByRole('status')).toHaveTextContent('Running');
    expect(screen.getByLabelText('RMS')).toHaveTextContent('0.4000');
  });
});

