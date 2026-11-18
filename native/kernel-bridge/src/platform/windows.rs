// Windows NT backend: talks to the kernel driver (ReaKernelDriver.sys)
// through CreateFileW + DeviceIoControl, and falls back to the Win32
// debugging API (ReadProcessMemory) for virtual-memory reads when the
// driver is not loaded.
//
// A syscall hook genuinely needs the driver: without it there is no event
// source, so `register_syscall_hook` returns an error instead of a hook id
// that would never fire.
#![cfg(target_os = "windows")]

use super::{EventCallback, KernelBackend, SyscallEventPayload};
use napi::bindgen_prelude::*;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows_sys::Win32::System::IO::DeviceIoControl;
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ};

const FILE_DEVICE_UNKNOWN: u32 = 0x00000022;
const METHOD_BUFFERED: u32 = 0;
const FILE_ANY_ACCESS: u32 = 0;

const fn ctl_code(device_type: u32, function: u32, method: u32, access: u32) -> u32 {
    (device_type << 16) | (access << 14) | (function << 2) | method
}

const IOCTL_REA_READ_PHYS_MEM: u32 = ctl_code(FILE_DEVICE_UNKNOWN, 0x801, METHOD_BUFFERED, FILE_ANY_ACCESS);
const IOCTL_REA_READ_VIRT_MEM: u32 = ctl_code(FILE_DEVICE_UNKNOWN, 0x802, METHOD_BUFFERED, FILE_ANY_ACCESS);
const IOCTL_REA_SUBSCRIBE_SYSCALL: u32 = ctl_code(FILE_DEVICE_UNKNOWN, 0x803, METHOD_BUFFERED, FILE_ANY_ACCESS);
const IOCTL_REA_DEQUEUE_EVENT: u32 = ctl_code(FILE_DEVICE_UNKNOWN, 0x804, METHOD_BUFFERED, FILE_ANY_ACCESS);

#[repr(C, packed)]
struct VirtMemRequest {
    pid: u32,
    virtual_address: u64,
    size: u64,
}

#[repr(C, packed)]
struct PhysMemRequest {
    physical_address: u64,
    size: u64,
}

#[repr(C, packed)]
#[derive(Copy, Clone, Default)]
struct RawKernelSyscallEvent {
    pid: u32,
    tid: u32,
    syscall_id: u32,
    args: [u64; 6],
    return_address: u64,
    image_name: [u8; 32],
}

pub struct WindowsNtBackend {
    driver_handle: HANDLE,
    next_hook_id: AtomicU32,
    polling_active: Arc<AtomicBool>,
    masked_pids: Arc<Mutex<HashSet<u32>>>,
}

unsafe impl Send for WindowsNtBackend {}
unsafe impl Sync for WindowsNtBackend {}

impl WindowsNtBackend {
    pub fn new() -> Self {
        Self {
            driver_handle: INVALID_HANDLE_VALUE,
            next_hook_id: AtomicU32::new(1),
            polling_active: Arc::new(AtomicBool::new(false)),
            masked_pids: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }
}

impl KernelBackend for WindowsNtBackend {
    fn connect(&mut self, driver_path: Option<String>) -> Result<bool> {
        let device_link = driver_path.unwrap_or_else(|| r"\\.\ReaKernelDriver".to_string());
        let wide_path = Self::to_wide(&device_link);

        let handle = unsafe {
            CreateFileW(
                wide_path.as_ptr(),
                0xC0000000, // GENERIC_READ | GENERIC_WRITE
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                0,
            )
        };

        if handle != INVALID_HANDLE_VALUE {
            self.driver_handle = handle;
        }
        // Even when the kernel driver is not loaded, the connection stays up
        // in user-space fallback mode (Win32 debugging API for memory reads).
        Ok(true)
    }

    fn read_physical_memory(&self, phys_addr: u64, size: usize) -> Result<Vec<u8>> {
        if self.driver_handle == INVALID_HANDLE_VALUE {
            return Err(Error::from_reason(
                "Reading physical memory requires an active connection to the kernel driver (.sys).",
            ));
        }

        let req = PhysMemRequest {
            physical_address: phys_addr,
            size: size as u64,
        };
        let mut out_buf = vec![0u8; size];
        let mut bytes_returned: u32 = 0;

        let ok = unsafe {
            DeviceIoControl(
                self.driver_handle,
                IOCTL_REA_READ_PHYS_MEM,
                &req as *const _ as *const _,
                std::mem::size_of::<PhysMemRequest>() as u32,
                out_buf.as_mut_ptr() as *mut _,
                size as u32,
                &mut bytes_returned,
                null_mut(),
            )
        };

        if ok == 0 {
            let err = unsafe { GetLastError() };
            return Err(Error::from_reason(format!(
                "IOCTL_REA_READ_PHYS_MEM failed: Win32 Error {err}"
            )));
        }

        out_buf.truncate(bytes_returned as usize);
        Ok(out_buf)
    }

    fn read_virtual_memory(&self, pid: u32, v_addr: u64, size: usize) -> Result<Vec<u8>> {
        let mut out_buf = vec![0u8; size];

        // 1. First choice: through the kernel driver (bypasses user-space handle limits).
        if self.driver_handle != INVALID_HANDLE_VALUE {
            let req = VirtMemRequest {
                pid,
                virtual_address: v_addr,
                size: size as u64,
            };
            let mut bytes_returned: u32 = 0;
            let ok = unsafe {
                DeviceIoControl(
                    self.driver_handle,
                    IOCTL_REA_READ_VIRT_MEM,
                    &req as *const _ as *const _,
                    std::mem::size_of::<VirtMemRequest>() as u32,
                    out_buf.as_mut_ptr() as *mut _,
                    size as u32,
                    &mut bytes_returned,
                    null_mut(),
                )
            };
            if ok != 0 {
                out_buf.truncate(bytes_returned as usize);
                return Ok(out_buf);
            }
        }

        // 2. Fallback: standard ReadProcessMemory.
        let proc_handle = unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid) };
        if proc_handle == 0 || proc_handle == INVALID_HANDLE_VALUE {
            let err = unsafe { GetLastError() };
            return Err(Error::from_reason(format!(
                "OpenProcess({pid}) failed with code {err}"
            )));
        }

        let mut bytes_read: usize = 0;
        let ok = unsafe {
            ReadProcessMemory(
                proc_handle,
                v_addr as *const _,
                out_buf.as_mut_ptr() as *mut _,
                size,
                &mut bytes_read,
            )
        };
        unsafe { CloseHandle(proc_handle) };

        if ok == 0 {
            let err = unsafe { GetLastError() };
            return Err(Error::from_reason(format!(
                "ReadProcessMemory failed at 0x{v_addr:x}: code {err}"
            )));
        }

        out_buf.truncate(bytes_read);
        Ok(out_buf)
    }

    fn register_syscall_hook(&mut self, syscall_name: String, cb: EventCallback) -> Result<u32> {
        if self.driver_handle == INVALID_HANDLE_VALUE {
            return Err(Error::from_reason(
                "Syscall hooks need the kernel driver (.sys) — without it there is no event source. Load the driver and reconnect first.",
            ));
        }

        let hook_id = self.next_hook_id.fetch_add(1, Ordering::SeqCst);

        let mut bytes_ret = 0u32;
        let name_bytes = syscall_name.as_bytes();
        unsafe {
            DeviceIoControl(
                self.driver_handle,
                IOCTL_REA_SUBSCRIBE_SYSCALL,
                name_bytes.as_ptr() as *const _,
                name_bytes.len() as u32,
                null_mut(),
                0,
                &mut bytes_ret,
                null_mut(),
            );
        }

        let handle_copy = self.driver_handle;
        let active_flag = self.polling_active.clone();
        let masked = self.masked_pids.clone();
        active_flag.store(true, Ordering::SeqCst);

        std::thread::spawn(move || {
            while active_flag.load(Ordering::Relaxed) {
                let mut raw_ev = RawKernelSyscallEvent::default();
                let mut bytes_returned = 0u32;
                let ok = unsafe {
                    DeviceIoControl(
                        handle_copy,
                        IOCTL_REA_DEQUEUE_EVENT,
                        null(),
                        0,
                        &mut raw_ev as *mut _ as *mut _,
                        std::mem::size_of::<RawKernelSyscallEvent>() as u32,
                        &mut bytes_returned,
                        null_mut(),
                    )
                };

                if ok != 0 && bytes_returned as usize == std::mem::size_of::<RawKernelSyscallEvent>() {
                    if masked.lock().contains(&raw_ev.pid) {
                        continue;
                    }
                    let nul_pos = raw_ev
                        .image_name
                        .iter()
                        .position(|&b| b == 0)
                        .unwrap_or(raw_ev.image_name.len());
                    let proc_name =
                        String::from_utf8_lossy(&raw_ev.image_name[..nul_pos]).into_owned();

                    cb(SyscallEventPayload {
                        pid: raw_ev.pid,
                        tid: raw_ev.tid,
                        process_name: proc_name,
                        syscall_id: raw_ev.syscall_id,
                        syscall_name: syscall_name.clone(),
                        args: raw_ev.args.iter().map(|&a| BigInt::from(a)).collect(),
                        return_address: BigInt::from(raw_ev.return_address),
                    });
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            }
        });

        Ok(hook_id)
    }

    fn set_pid_visibility_mask(&mut self, pid: u32, hidden: bool) -> Result<bool> {
        let mut set = self.masked_pids.lock();
        if hidden {
            set.insert(pid);
        } else {
            set.remove(&pid);
        }
        Ok(true)
    }
}

impl Drop for WindowsNtBackend {
    fn drop(&mut self) {
        self.polling_active.store(false, Ordering::SeqCst);
        if self.driver_handle != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.driver_handle) };
        }
    }
}
