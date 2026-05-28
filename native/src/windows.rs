//! Windows PTY via ConPTY. CreatePseudoConsole + a STARTUPINFOEXW carrying the
//! PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE attribute, launched with CreateProcessW.
//! I/O is raw ReadFile/WriteFile on the pipe handles (no streams).

use core::ffi::c_void;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, PROCESS_INFORMATION, STARTUPINFOEXW, STARTUPINFOW,
};

const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
const INFINITE: u32 = 0xFFFF_FFFF;

#[derive(Clone, Copy)]
pub struct PtyHandle {
    input_write: isize,
    output_read: isize,
    hpc: isize,
    hprocess: isize,
}

impl PtyHandle {
    pub fn clone_for_reader(&self) -> PtyHandle {
        *self
    }
}

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

pub fn spawn(
    file: &str,
    args: &[String],
    cols: u16,
    rows: u16,
    cwd: Option<&str>,
) -> Result<PtyHandle, String> {
    unsafe {
        // Two anonymous pipes: child stdin (we write input_write -> input_read),
        // child stdout (output_write -> we read output_read).
        let mut input_read: HANDLE = ptr::null_mut();
        let mut input_write: HANDLE = ptr::null_mut();
        let mut output_read: HANDLE = ptr::null_mut();
        let mut output_write: HANDLE = ptr::null_mut();
        if CreatePipe(&mut input_read, &mut input_write, ptr::null(), 0) == 0 {
            return Err("CreatePipe(input) failed".into());
        }
        if CreatePipe(&mut output_read, &mut output_write, ptr::null(), 0) == 0 {
            return Err("CreatePipe(output) failed".into());
        }

        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        let mut hpc: HPCON = std::mem::zeroed();
        let hr = CreatePseudoConsole(size, input_read, output_write, 0, &mut hpc);
        if hr != 0 {
            return Err(format!("CreatePseudoConsole failed (hr={hr})"));
        }
        // ConPTY duplicated these; the parent doesn't need its copies.
        CloseHandle(input_read);
        CloseHandle(output_write);

        // Build the attribute list carrying the pseudoconsole.
        let mut attr_size: usize = 0;
        InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut attr_size);
        let mut attr_buf: Vec<u8> = vec![0u8; attr_size];
        let attr_list = attr_buf.as_mut_ptr() as *mut c_void;
        if InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) == 0 {
            return Err("InitializeProcThreadAttributeList failed".into());
        }
        if UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            hpc as *const c_void,
            std::mem::size_of::<HPCON>(),
            ptr::null_mut(),
            ptr::null_mut(),
        ) == 0
        {
            return Err("UpdateProcThreadAttribute failed".into());
        }

        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.lpAttributeList = attr_list;

        // Command line: file + args joined (simple; assumes no embedded quoting needs).
        let mut cmdline = String::from(file);
        for a in args {
            cmdline.push(' ');
            cmdline.push_str(a);
        }
        let mut cmd_w = wide(&cmdline);
        let cwd_w = cwd.map(wide);
        let cwd_ptr = cwd_w
            .as_ref()
            .map(|v| v.as_ptr())
            .unwrap_or(ptr::null());

        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            ptr::null(),
            cmd_w.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            0, // bInheritHandles = FALSE (ConPTY handles inheritance)
            EXTENDED_STARTUPINFO_PRESENT,
            ptr::null(),
            cwd_ptr,
            &si as *const STARTUPINFOEXW as *const STARTUPINFOW,
            &mut pi,
        );
        DeleteProcThreadAttributeList(attr_list);
        if ok == 0 {
            ClosePseudoConsole(hpc);
            return Err("CreateProcessW failed".into());
        }
        CloseHandle(pi.hThread);

        Ok(PtyHandle {
            input_write: input_write as isize,
            output_read: output_read as isize,
            hpc: hpc as isize,
            hprocess: pi.hProcess as isize,
        })
    }
}

pub fn read(h: &PtyHandle, buf: &mut [u8]) -> Option<usize> {
    let mut n: u32 = 0;
    let ok = unsafe {
        ReadFile(
            h.output_read as HANDLE,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut n,
            ptr::null_mut(),
        )
    };
    if ok != 0 {
        Some(n as usize) // 0 == EOF
    } else {
        None // broken pipe when the child exits
    }
}

pub fn write(h: &PtyHandle, data: &[u8]) -> Result<(), String> {
    let mut off = 0usize;
    while off < data.len() {
        let mut n: u32 = 0;
        let ok = unsafe {
            WriteFile(
                h.input_write as HANDLE,
                data[off..].as_ptr(),
                (data.len() - off) as u32,
                &mut n,
                ptr::null_mut(),
            )
        };
        if ok == 0 || n == 0 {
            return Err("write failed".into());
        }
        off += n as usize;
    }
    Ok(())
}

pub fn resize(h: &PtyHandle, cols: u16, rows: u16) -> Result<(), String> {
    let size = COORD {
        X: cols as i16,
        Y: rows as i16,
    };
    let hr = unsafe { ResizePseudoConsole(h.hpc as HPCON, size) };
    if hr != 0 {
        Err(format!("resize failed (hr={hr})"))
    } else {
        Ok(())
    }
}

pub fn wait(h: &PtyHandle) -> i32 {
    unsafe {
        WaitForSingleObject(h.hprocess as HANDLE, INFINITE);
        let mut code: u32 = 0;
        GetExitCodeProcess(h.hprocess as HANDLE, &mut code);
        code as i32
    }
}

pub fn kill(h: &PtyHandle) {
    unsafe {
        TerminateProcess(h.hprocess as HANDLE, 1);
        ClosePseudoConsole(h.hpc as HPCON);
    }
}
