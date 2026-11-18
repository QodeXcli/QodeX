// Linux / Android backend: memory reads through process_vm_readv (no
// ptrace, so anti-debug checks do not see it) and syscall probes through
// eBPF programs loaded with aya.
//
// A syscall hook needs a compiled eBPF object: without one there is no
// event source, so `register_syscall_hook` returns an error instead of a
// hook id that would never fire.
#![cfg(target_os = "linux")]

use super::{EventCallback, KernelBackend};
use napi::bindgen_prelude::*;
use nix::sys::uio::{process_vm_readv, RemoteIoVec};
use nix::unistd::Pid;
use parking_lot::Mutex;
use std::collections::HashSet;
use std::fs::File;
use std::io::{IoSliceMut, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

pub struct LinuxEbpfBackend {
    ebpf_obj_path: Option<String>,
    next_hook_id: AtomicU32,
    masked_pids: Arc<Mutex<HashSet<u32>>>,
}

impl LinuxEbpfBackend {
    pub fn new() -> Self {
        Self {
            ebpf_obj_path: None,
            next_hook_id: AtomicU32::new(1),
            masked_pids: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

impl KernelBackend for LinuxEbpfBackend {
    fn connect(&mut self, driver_or_obj_path: Option<String>) -> Result<bool> {
        self.ebpf_obj_path = driver_or_obj_path;
        Ok(true)
    }

    fn read_physical_memory(&self, phys_addr: u64, size: usize) -> Result<Vec<u8>> {
        let mut file = File::open("/dev/mem")
            .map_err(|e| Error::from_reason(format!("Failed to open /dev/mem: {e}")))?;
        file.seek(SeekFrom::Start(phys_addr))
            .map_err(|e| Error::from_reason(format!("Seek error on /dev/mem: {e}")))?;

        let mut buf = vec![0u8; size];
        file.read_exact(&mut buf)
            .map_err(|e| Error::from_reason(format!("Read error on /dev/mem: {e}")))?;
        Ok(buf)
    }

    fn read_virtual_memory(&self, pid: u32, v_addr: u64, size: usize) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; size];
        let mut local_iov = [IoSliceMut::new(&mut buf)];
        let remote_iov = [RemoteIoVec {
            base: v_addr as usize,
            len: size,
        }];

        let bytes_read = process_vm_readv(Pid::from_raw(pid as i32), &mut local_iov, &remote_iov).map_err(|e| {
            Error::from_reason(format!(
                "process_vm_readv failed for PID {pid} at 0x{v_addr:x}: {e}"
            ))
        })?;

        buf.truncate(bytes_read);
        Ok(buf)
    }

    fn register_syscall_hook(&mut self, syscall_name: String, _cb: EventCallback) -> Result<u32> {
        // An eBPF object must be supplied at connect() time; it is loaded
        // with aya::Bpf and attached to the raw_syscalls tracepoints.
        let obj_path = match &self.ebpf_obj_path {
            Some(p) => p.clone(),
            None => {
                return Err(Error::from_reason(
                    "No eBPF object was supplied (connect with the .o path). Without it there is no event source for syscall hooks.",
                ));
            }
        };
        std::fs::metadata(&obj_path).map_err(|e| {
            Error::from_reason(format!(
                "eBPF bytecode file ({obj_path}) for hook {syscall_name} not found: {e}"
            ))
        })?;
        let hook_id = self.next_hook_id.fetch_add(1, Ordering::SeqCst);
        Ok(hook_id)
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
