//! POSIX PTY via forkpty. forkpty() sets up the slave as the child's controlling
//! terminal and dup2's it onto the child's stdio, so the child just execs.

use libc::{c_char, c_int, c_void};
use std::ffi::CString;
use std::ptr;

#[derive(Clone, Copy)]
pub struct PtyHandle {
    fd: c_int,
    pid: c_int,
}

impl PtyHandle {
    pub fn clone_for_reader(&self) -> PtyHandle {
        *self
    }
}

pub fn spawn(
    file: &str,
    args: &[String],
    cols: u16,
    rows: u16,
    cwd: Option<&str>,
) -> Result<PtyHandle, String> {
    // Build every allocation BEFORE forking — the child may only call
    // async-signal-safe functions (no malloc) before execvp.
    let prog = CString::new(file).map_err(|_| "invalid file".to_string())?;
    let mut argv_owned: Vec<CString> = Vec::with_capacity(args.len() + 1);
    argv_owned.push(prog.clone());
    for a in args {
        argv_owned.push(CString::new(a.as_str()).map_err(|_| "invalid arg".to_string())?);
    }
    let mut argv: Vec<*const c_char> = argv_owned.iter().map(|c| c.as_ptr()).collect();
    argv.push(ptr::null());
    let cwd_c = match cwd {
        Some(d) => Some(CString::new(d).map_err(|_| "invalid cwd".to_string())?),
        None => None,
    };

    let mut ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    let mut master: c_int = 0;
    // macOS declares termp/winp as *mut (Linux uses *const); *mut coerces to *const,
    // so passing *mut compiles on both.
    let pid = unsafe {
        libc::forkpty(
            &mut master,
            ptr::null_mut(),
            ptr::null_mut::<libc::termios>(),
            &mut ws as *mut libc::winsize,
        )
    };
    if pid < 0 {
        return Err("forkpty failed".to_string());
    }
    if pid == 0 {
        // CHILD — async-signal-safe only.
        unsafe {
            if let Some(ref c) = cwd_c {
                libc::chdir(c.as_ptr());
            }
            libc::execvp(prog.as_ptr(), argv.as_ptr());
            libc::_exit(127);
        }
    }
    Ok(PtyHandle { fd: master, pid })
}

pub fn read(h: &PtyHandle, buf: &mut [u8]) -> Option<usize> {
    let n = unsafe { libc::read(h.fd, buf.as_mut_ptr() as *mut c_void, buf.len()) };
    if n >= 0 {
        Some(n as usize) // 0 == EOF
    } else {
        None // error (EIO when the slave closes)
    }
}

pub fn write(h: &PtyHandle, data: &[u8]) -> Result<(), String> {
    let mut off = 0usize;
    while off < data.len() {
        let n = unsafe {
            libc::write(
                h.fd,
                data[off..].as_ptr() as *const c_void,
                data.len() - off,
            )
        };
        if n <= 0 {
            return Err("write failed".to_string());
        }
        off += n as usize;
    }
    Ok(())
}

pub fn resize(h: &PtyHandle, cols: u16, rows: u16) -> Result<(), String> {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let r = unsafe { libc::ioctl(h.fd, libc::TIOCSWINSZ as _, &ws) };
    if r != 0 {
        Err("resize failed".to_string())
    } else {
        Ok(())
    }
}

pub fn wait(h: &PtyHandle) -> i32 {
    let mut status: c_int = 0;
    unsafe {
        libc::waitpid(h.pid, &mut status, 0);
        if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            -1
        }
    }
}

pub fn kill(h: &PtyHandle) {
    unsafe {
        libc::kill(h.pid, libc::SIGHUP);
    }
}
