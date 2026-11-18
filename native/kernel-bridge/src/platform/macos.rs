// macOS / XNU backend: target memory through the XNU Mach traps
// (task_for_pid + mach_vm_read_overwrite); syscall interception goes through
// a direct binding to libEndpointSecurity.dylib (see build.rs).
//
// Physical-memory reads are blocked by SIP on XNU — use the virtual-memory
// path. The EndpointSecurity client is not wired yet: `register_syscall_hook`
// returns a clear error rather than a hook id that would never fire.
#![cfg(target_os = "macos")]

use super::{EventCallback, KernelBackend, SyscallEventPayload};
use libc::{c_int, c_uint, c_void, kern_return_t, mach_port_t, pid_t};
use napi::bindgen_prelude::*;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

extern "C" {
    fn mach_task_self() -> mach_port_t;
    fn task_for_pid(target_tport: mach_port_t, pid: c_int, t: *mut mach_port_t) -> kern_return_t;
    fn mach_vm_read_overwrite(
        target_task: mach_port_t,
        address: u64,
        size: u64,
        data: u64,
        outsize: *mut u64,
    ) -> kern_return_t;
}

pub struct MacOsXnuBackend {
    connected: bool,
    next_hook_id: AtomicU32,
    callbacks: Arc<Mutex<Vec<(String, EventCallback)>>>,
    masked_pids: Arc<Mutex<HashSet<u32>>>,
}

impl MacOsXnuBackend {
    pub fn new() -> Self {
        Self {
            connected: false,
            next_hook_id: AtomicU32::new(1),
            callbacks: Arc::new(Mutex::new(Vec::new())),
            masked_pids: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

impl KernelBackend for MacOsXnuBackend {
    fn connect(&mut self, _driver_path: Option<String>) -> Result<bool> {
        self.connected = true;
        Ok(true)
    }

    fn read_physical_memory(&self, _phys_addr: u64, _size: usize) -> Result<Vec<u8>> {
        Err(Error::from_reason(
            "Direct physical-memory access is blocked by SIP on XNU; use readProcessVirtualMemory instead.",
        ))
    }

    fn read_virtual_memory(&self, pid: u32, v_addr: u64, size: usize) -> Result<Vec<u8>> {
        let mut task: mach_port_t = 0;
        let kr = unsafe { task_for_pid(mach_task_self(), pid as pid_t, &mut task) };
        if kr != 0 {
            return Err(Error::from_reason(format!(
                "task_for_pid({pid}) failed (kern_return={kr}). Make sure the binary has the com.apple.security.cs.debugger entitlement and runs with sudo."
            )));
        }

        let mut buffer = vec![0u8; size];
        let mut out_size: u64 = 0;

        let read_kr = unsafe {
            mach_vm_read_overwrite(
                task,
                v_addr,
                size as u64,
                buffer.as_mut_ptr() as u64,
                &mut out_size,
            )
        };

        if read_kr != 0 {
            return Err(Error::from_reason(format!(
                "mach_vm_read_overwrite failed at 0x{v_addr:x} (kern_return={read_kr})"
            )));
        }

        buffer.truncate(out_size as usize);
        Ok(buffer)
    }

    fn register_syscall_hook(&mut self, syscall_name: String, _cb: EventCallback) -> Result<u32> {
        // The EndpointSecurity client (es_new_client + es_subscribe) is not
        // wired yet — registering a callback that never fires would be a
        // silent no-op. Wire es_new_client first, then store the callback.
        let _ = syscall_name;
        let _ = self.next_hook_id.load(Ordering::SeqCst);
        let _ = &self.callbacks;
        Err(Error::from_reason(
            "EndpointSecurity client is not wired yet (es_new_client + es_subscribe). No syscall events can be delivered on macOS until it is.",
        ))
    }

    fn set_pid_visibility_mask(&mut self, pid: u32, hidden: bool) -> Result<bool> {
        let mut masked = self.masked_pids.lock();
        if hidden {
            masked.insert(pid);
        } else {
            masked.remove(&pid);
        }
        Ok(true)
    }
}
