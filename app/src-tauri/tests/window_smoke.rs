//! Smoke test: launch the real app binary and confirm a visible top-level
//! window titled "BIForge" appears for that process. Stops only the child it
//! started, by handle/PID.
#![cfg(windows)]

use std::process::Command;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

struct Search {
    pid: u32,
    found_title: Option<String>,
    hwnd: isize,
}

unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let s = &mut *(lparam as *mut Search);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == s.pid && IsWindowVisible(hwnd) != 0 {
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        if title == "BIForge" {
            s.found_title = Some(title);
            s.hwnd = hwnd as isize;
            return 0;
        }
    }
    1
}

#[test]
fn app_window_opens_with_expected_title() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_biforge-app"))
        .spawn()
        .expect("failed to launch biforge-app");
    let mut search = Search { pid: child.id(), found_title: None, hwnd: 0 };
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && search.found_title.is_none() {
        if let Ok(Some(status)) = child.try_wait() {
            panic!("app exited early: {status}");
        }
        unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
        std::thread::sleep(Duration::from_millis(500));
    }
    let _ = child.kill(); // our own child only
    let _ = child.wait();
    assert_eq!(search.found_title.as_deref(), Some("BIForge"), "window did not appear");
}

