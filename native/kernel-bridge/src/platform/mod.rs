// Platform abstraction for the REA kernel bridge.
//
// One contract (`KernelBackend`) that all three operating systems implement.
// Kernel events come back as `SyscallEventPayload`, a plain struct the
// N-API layer can hand to TypeScript through a ThreadsafeFunction.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "linux")]
pub mod linux;

#[napi(object)]
#[derive(Clone, Debug)]
pub struct SyscallEventPayload {
    pub pid: u32,
    pub tid: u32,
    pub process_name: String,
    pub syscall_id: u32,
    pub syscall_name: String,
    pub args: Vec<BigInt>,
    pub return_address: BigInt,
}

pub type EventCallback = Arc<dyn Fn(SyscallEventPayload) + Send + Sync + 'static>;

pub trait KernelBackend: Send + Sync {
    fn connect(&mut self, driver_or_obj_path: Option<String>) -> Result<bool>;
    fn read_physical_memory(&self, phys_addr: u64, size: usize) -> Result<Vec<u8>>;
    fn read_virtual_memory(&self, pid: u32, v_addr: u64, size: usize) -> Result<Vec<u8>>;
    fn register_syscall_hook(&mut self, syscall_name: String, cb: EventCallback) -> Result<u32>;
    fn set_pid_visibility_mask(&mut self, pid: u32, hidden: bool) -> Result<bool>;
}

pub fn create_platform_backend() -> Box<dyn KernelBackend> {
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsNtBackend::new())
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacOsXnuBackend::new())
    }
    #[cfg(target_os = "linux")]
    {
        Box::new(linux::LinuxEbpfBackend::new())
    }
}
