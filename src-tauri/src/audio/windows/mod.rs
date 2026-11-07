// Pure conversion is available on every platform; OS format parsing belongs
// in the Windows capture adapter.
pub mod format;

#[cfg(windows)]
mod loopback;
#[cfg(windows)]
mod notifications;
#[cfg(windows)]
pub use loopback::{CaptureStopHandle, WindowsWasapiCapture};
