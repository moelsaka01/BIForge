//! System keys must reach Windows. Pressing and releasing Alt alone makes Windows enter its window-menu mode
//! (WM_SYSCOMMAND / SC_KEYMENU with no mnemonic), and in that mode the next key press is swallowed: Print Screen did
//! nothing after an Alt tap. BIForge uses Alt for its own key tips and has no window menu, so the menu mode is
//! refused here. Alt+Space (the system menu) carries a mnemonic in `lparam` and is left alone.

/// WM_SYSCOMMAND with SC_KEYMENU and no mnemonic: the Alt tap that would start the menu mode.
pub fn is_alt_tap_menu_request(msg: u32, wparam: usize, lparam: isize) -> bool {
    const WM_SYSCOMMAND: u32 = 0x0112;
    const SC_KEYMENU: usize = 0xF100;
    msg == WM_SYSCOMMAND && (wparam & 0xFFF0) == SC_KEYMENU && lparam == 0
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};

    unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if super::is_alt_tap_menu_request(msg, wparam, lparam) {
            return 0;
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub fn install(hwnd: isize) -> bool {
        // SAFETY: `hwnd` is the main window's handle, alive for the whole run; the callback is a plain function.
        unsafe { SetWindowSubclass(hwnd as HWND, Some(proc), 1, 0) != 0 }
    }
}

/// Installs the filter on the window with this handle. Returns whether it is in place.
pub fn install(hwnd: isize) -> bool {
    #[cfg(windows)]
    {
        win::install(hwnd)
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_bare_alt_tap_is_refused() {
        assert!(is_alt_tap_menu_request(0x0112, 0xF100, 0)); // Alt tap
        assert!(is_alt_tap_menu_request(0x0112, 0xF10F, 0)); // low bits of wparam are flags
        assert!(!is_alt_tap_menu_request(0x0112, 0xF100, 0x20)); // Alt+Space opens the system menu
        assert!(!is_alt_tap_menu_request(0x0112, 0xF060, 0)); // SC_CLOSE
        assert!(!is_alt_tap_menu_request(0x0112, 0xF020, 0)); // SC_MINIMIZE
        assert!(!is_alt_tap_menu_request(0x0100, 0xF100, 0)); // not a WM_SYSCOMMAND
    }
}
