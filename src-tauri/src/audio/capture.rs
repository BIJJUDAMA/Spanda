use std::sync::atomic::AtomicBool;

use super::types::{AudioBlock, CaptureError};

/// Runs synchronously on its owning worker; never starts itself.
/// Implementations must observe stop during waits and recovery, release all
/// capture resources before returning, and never retain the borrowed sink block.
/// The sink must stay bounded and must not perform blocking I/O or UI work.
pub trait AudioCapture {
    fn run(
        &mut self,
        stop: &AtomicBool,
        sink: &mut dyn FnMut(&AudioBlock),
    ) -> Result<(), CaptureError>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureState {
    Idle,
    Starting,
    Running,
    Recovering,
    Stopping,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureEvent {
    Start,
    Opened,
    DeviceLost,
    Failed,
    Stop,
    Stopped,
}

/// Pure reducer; the owner must serialize applying events and their effects.
/// Spawn only on entry to Starting from Idle/Error, never just because the
/// returned state is Starting. Idle and Error guarantee no owned worker remains:
/// apply terminal Failed/Stopped only after cleanup and worker retirement.
/// During cancellation, acknowledge retirement with Stopped even on failure;
/// Failed cannot bypass Stopping. Preserve any error details separately.
/// The owner must reject events from old session generations before reducing.
pub fn transition(state: CaptureState, event: CaptureEvent) -> CaptureState {
    use CaptureEvent::*;
    use CaptureState::{Error, Idle, Recovering, Running, Starting, Stopping};

    match (state, event) {
        (Idle | Error, Start) => Starting,
        (Starting | Recovering, Opened) => Running,
        (Starting | Running, DeviceLost) => Recovering,
        (Starting | Running | Recovering, Failed | Stopped) => Error,
        (Starting | Running | Recovering, Stop) => Stopping,
        (Stopping, Stopped) | (Error, Stop) => Idle,
        _ => state,
    }
}

#[cfg(test)]
mod tests {
    use super::{transition, CaptureEvent::*, CaptureState};
    use CaptureState::{Error, Idle, Recovering, Running, Starting, Stopping};

    #[test]
    fn duplicate_start_cannot_create_another_session() {
        let mut state = Idle;
        let mut sessions = 0;
        for event in [
            Start, Start, Opened, Start, DeviceLost, Start, Stop, Start, Stopped,
        ] {
            let next = transition(state, event);
            // A session is accepted only on entry to Starting, not while there.
            if state != Starting && next == Starting {
                sessions += 1;
            }
            state = next;
        }
        assert_eq!(sessions, 1);
        assert_eq!(state, Idle);
    }

    #[test]
    fn stop_from_idle_is_harmless() {
        assert_eq!(transition(Idle, Stop), Idle);
    }

    #[test]
    fn recovery_stops_cleanly() {
        let mut state = Idle;
        for (event, expected) in [
            (Start, Starting),
            (Opened, Running),
            (DeviceLost, Recovering),
            (Opened, Running),
            (DeviceLost, Recovering),
            (Stop, Stopping),
            (Opened, Stopping),
            (DeviceLost, Stopping),
            (Failed, Stopping),
            (Start, Stopping),
            (Stopped, Idle),
        ] {
            state = transition(state, event);
            assert_eq!(state, expected);
        }
    }

    #[test]
    fn stop_during_open_cannot_resurrect_capture() {
        let mut state = transition(Idle, Start);
        for (event, expected) in [
            (Stop, Stopping),
            (Opened, Stopping),
            (Stop, Stopping),
            (Stopped, Idle),
            (Opened, Idle),
            (Failed, Idle),
        ] {
            state = transition(state, event);
            assert_eq!(state, expected);
        }
        assert_eq!(transition(state, Start), Starting);
    }

    #[test]
    fn terminal_failure_allows_explicit_retry_or_dismissal() {
        for state in [Starting, Running, Recovering] {
            assert_eq!(transition(state, Failed), Error);
        }
        assert_eq!(transition(Error, Opened), Error);
        assert_eq!(transition(Error, Stopped), Error);
        assert_eq!(transition(Error, Start), Starting);
        assert_eq!(transition(Error, Stop), Idle);
    }

    #[test]
    fn unexpected_worker_exit_is_an_error() {
        for state in [Starting, Running, Recovering] {
            assert_eq!(transition(state, Stopped), Error);
        }
    }

    #[test]
    fn lifecycle_event_matrix() {
        // Event order: Start, Opened, DeviceLost, Failed, Stop, Stopped.
        let rows = [
            (Idle, [Starting, Idle, Idle, Idle, Idle, Idle]),
            (
                Starting,
                [Starting, Running, Recovering, Error, Stopping, Error],
            ),
            (
                Running,
                [Running, Running, Recovering, Error, Stopping, Error],
            ),
            (
                Recovering,
                [Recovering, Running, Recovering, Error, Stopping, Error],
            ),
            (
                Stopping,
                [Stopping, Stopping, Stopping, Stopping, Stopping, Idle],
            ),
            (Error, [Starting, Error, Error, Error, Idle, Error]),
        ];
        for (state, expected) in rows {
            for (event, expected) in [Start, Opened, DeviceLost, Failed, Stop, Stopped]
                .into_iter()
                .zip(expected)
            {
                assert_eq!(transition(state, event), expected, "{state:?} + {event:?}");
            }
        }
    }
}
