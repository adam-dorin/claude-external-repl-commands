//! First-party PTY host addon for eclaude. Exposes a small node-pty-like surface:
//! `Pty.spawn(file, args, cols, rows, cwd?, onData, onExit)`, `.write`, `.resize`, `.kill`.
//! Platform syscalls (forkpty / ConPTY) live in the per-OS modules; no third-party
//! PTY crate.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::JsFunction;
use napi_derive::napi;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as sys;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as sys;

/// A live pseudo-terminal hosting a child process.
#[napi]
pub struct Pty {
    handle: sys::PtyHandle,
}

#[napi]
impl Pty {
    /// Spawn `file` with `args` inside a new pty of `cols`x`rows`. `on_data` is called
    /// with a Buffer for each chunk of output; `on_exit` is called once with the exit code.
    #[napi(factory)]
    pub fn spawn(
        file: String,
        args: Vec<String>,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        on_data: JsFunction,
        on_exit: JsFunction,
    ) -> Result<Pty> {
        let data_tsfn: ThreadsafeFunction<Vec<u8>, ErrorStrategy::Fatal> = on_data
            .create_threadsafe_function(0, |ctx| {
                ctx.env
                    .create_buffer_with_data(ctx.value)
                    .map(|b| vec![b.into_raw()])
            })?;
        let exit_tsfn: ThreadsafeFunction<i32, ErrorStrategy::Fatal> =
            on_exit.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

        let handle = sys::spawn(&file, &args, cols, rows, cwd.as_deref())
            .map_err(|e| Error::new(Status::GenericFailure, e))?;

        // Reader thread: pump pty output -> onData. On POSIX this ends at EOF when
        // the child exits; on Windows ConPTY the pipe doesn't EOF on exit, so the
        // reader is torn down with the process.
        let reader = handle.clone_for_reader();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match sys::read(&reader, &mut buf) {
                    Some(n) if n > 0 => {
                        data_tsfn.call(buf[..n].to_vec(), ThreadsafeFunctionCallMode::Blocking);
                    }
                    _ => break,
                }
            }
        });

        // Waiter thread: block on the child and report its exit code. Uses the
        // process handle (Windows) / waitpid (POSIX), independent of pipe EOF.
        let waiter = handle.clone_for_reader();
        std::thread::spawn(move || {
            let code = sys::wait(&waiter);
            exit_tsfn.call(code, ThreadsafeFunctionCallMode::Blocking);
        });

        Ok(Pty { handle })
    }

    #[napi]
    pub fn write(&self, data: Buffer) -> Result<()> {
        sys::write(&self.handle, &data[..]).map_err(|e| Error::new(Status::GenericFailure, e))
    }

    #[napi]
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        sys::resize(&self.handle, cols, rows).map_err(|e| Error::new(Status::GenericFailure, e))
    }

    #[napi]
    pub fn kill(&self) -> Result<()> {
        sys::kill(&self.handle);
        Ok(())
    }
}
