// Native binary patcher — injects a library dependency into a mobile
// binary without any external tool (no LIEF, no optool).
//
// Mach-O: appends an LC_LOAD_DYLIB command into the padding between the
// end of the load commands and the first section, and bumps ncmds /
// sizeofcmds. If there is no zero padding large enough, it returns an
// error instead of overwriting section data.
//
// ELF: adds a DT_NEEDED entry. That needs two things — a free dynamic
// entry slot and room for the library name in .dynstr. The implementation
// repurposes a DT_DEBUG entry (present in most linked binaries, value 0 in
// the file) and writes the name into trailing NUL slack in .dynstr. When
// either is missing it returns a clear error (use LIEF, which shifts
// sections, or rebuild the binary with the dependency) instead of
// reporting success without changing anything.

use goblin::elf::dynamic::{DT_DEBUG, DT_NEEDED};
use goblin::elf::section_header::{SHT_DYNAMIC, SHT_STRTAB};
use goblin::Object;
use napi::bindgen_prelude::*;
use scroll::{Pread, Pwrite};
use std::fs;

const LC_LOAD_DYLIB: u32 = 0x0c;

#[repr(C)]
#[derive(Debug, Copy, Clone, Pread, Pwrite)]
struct DylibCommandHeader {
    cmd: u32,
    cmdsize: u32,
    name_offset: u32,
    timestamp: u32,
    current_version: u32,
    compatibility_version: u32,
}

pub fn inject_macho_load_dylib(macho_path: &str, dylib_install_name: &str) -> Result<()> {
    let mut bytes = fs::read(macho_path)
        .map_err(|e| Error::from_reason(format!("Failed to read Mach-O file: {e}")))?;

    let obj = Object::parse(&bytes)
        .map_err(|e| Error::from_reason(format!("Invalid binary format: {e}")))?;

    match obj {
        Object::Mach(goblin::mach::Mach::Binary(macho)) => {
            let is_64 = macho.is_64;
            let header_size = if is_64 { 32 } else { 28 };
            let ncmds = macho.header.ncmds;
            let sizeofcmds = macho.header.sizeofcmds as usize;

            // Build the LC_LOAD_DYLIB payload, 8-byte aligned.
            let mut name_bytes = dylib_install_name.as_bytes().to_vec();
            name_bytes.push(0); // NUL terminator
            let raw_len = std::mem::size_of::<DylibCommandHeader>() + name_bytes.len();
            let aligned_cmd_size = (raw_len + 7) & !7;

            let cmd_header = DylibCommandHeader {
                cmd: LC_LOAD_DYLIB,
                cmdsize: aligned_cmd_size as u32,
                name_offset: 24,
                timestamp: 2,
                current_version: 0x00010000,
                compatibility_version: 0x00010000,
            };

            let insert_offset = header_size + sizeofcmds;
            let insert_end = insert_offset + aligned_cmd_size;

            // Never overwrite section data: the target region must be inside
            // the file and consist entirely of zero padding.
            if insert_end > bytes.len() {
                return Err(Error::from_reason(
                    "No room for a new load command: the Mach-O header runs to the end of the file.",
                ));
            }
            if bytes[insert_offset..insert_end].iter().any(|&b| b != 0) {
                return Err(Error::from_reason(
                    "No zero padding after the load commands: the new LC_LOAD_DYLIB would overwrite section data. Rebuild the binary with a larger header (e.g. -headerpad_max_install_names) or use a tool that shifts sections.",
                ));
            }

            let mut cmd_buf = vec![0u8; aligned_cmd_size];
            cmd_buf
                .pwrite(cmd_header, 0)
                .map_err(|e| Error::from_reason(format!("Failed to serialise Dylib header: {e}")))?;
            cmd_buf[24..24 + name_bytes.len()].copy_from_slice(&name_bytes);

            bytes[insert_offset..insert_end].copy_from_slice(&cmd_buf);

            // ncmds at header offset 16, sizeofcmds at 20 (both 32/64-bit).
            // Modern Apple binaries are little-endian.
            bytes
                .pwrite_with(ncmds as u32 + 1, 16, scroll::LE)
                .map_err(|e| Error::from_reason(format!("Failed to update ncmds: {e}")))?;
            bytes
                .pwrite_with(sizeofcmds as u32 + aligned_cmd_size as u32, 20, scroll::LE)
                .map_err(|e| Error::from_reason(format!("Failed to update sizeofcmds: {e}")))?;

            fs::write(macho_path, &bytes)
                .map_err(|e| Error::from_reason(format!("Failed to write patched Mach-O file: {e}")))?;
            Ok(())
        }
        _ => Err(Error::from_reason(
            "Input is not a single-architecture Mach-O binary.",
        )),
    }
}

pub fn inject_elf_dt_needed(elf_path: &str, library_name: &str) -> Result<()> {
    let mut bytes = fs::read(elf_path)
        .map_err(|e| Error::from_reason(format!("Failed to read ELF file: {e}")))?;

    // Extract everything needed from the parsed ELF first, then drop the
    // borrow — the byte buffer cannot be mutated while `elf` borrows it.
    let plan = {
        let obj = Object::parse(&bytes).map_err(|e| Error::from_reason(e.to_string()))?;
        let elf = match obj {
            Object::Elf(elf) => elf,
            _ => return Err(Error::from_reason("Input is not a valid ELF binary.")),
        };

        if elf.libraries.contains(&library_name) {
            return Ok(()); // Already in DT_NEEDED.
        }
        let dynamic = match &elf.dynamic {
            Some(d) => d,
            None => {
                return Err(Error::from_reason(
                    "ELF binary has no .dynamic table, so no DT_NEEDED can be added.",
                ));
            }
        };

        // 1. Find a DT_DEBUG entry to repurpose (d_tag 21, value 0 in the file).
        let debug_idx = dynamic
            .dyns
            .iter()
            .position(|d| d.d_tag == DT_DEBUG as u64)
            .ok_or_else(|| {
                Error::from_reason(
                    "No DT_DEBUG entry to repurpose and no free dynamic slot: cannot add DT_NEEDED without shifting sections. Use LIEF or rebuild the binary with the dependency.",
                )
            })?;

        // 2. Find the .dynamic section header for the entry's file offset.
        let dyn_sh = elf
            .section_headers
            .iter()
            .find(|sh| sh.sh_type == SHT_DYNAMIC)
            .ok_or_else(|| Error::from_reason("No SHT_DYNAMIC section header found."))?;
        let entry_size: u64 = if elf.is_64 { 16 } else { 8 };
        let entry_offset = dyn_sh.sh_offset + debug_idx as u64 * entry_size;

        // 3. Find trailing NUL slack in .dynstr large enough for the name.
        let dynstr_sh = elf
            .section_headers
            .iter()
            .find(|sh| {
                sh.sh_type == SHT_STRTAB
                    && elf
                        .shdr_strtab
                        .get_at(sh.sh_name)
                        .map(|n| n == ".dynstr")
                        .unwrap_or(false)
            })
            .ok_or_else(|| Error::from_reason("No .dynstr section header found."))?;
        let str_start = dynstr_sh.sh_offset as usize;
        let str_end = str_start + dynstr_sh.sh_size as usize;
        if str_end > bytes.len() {
            return Err(Error::from_reason(
                ".dynstr section runs past the end of the file.",
            ));
        }
        let last_nonzero = bytes[str_start..str_end].iter().rposition(|&b| b != 0);
        let slack_start = match last_nonzero {
            Some(i) => i + 1,
            None => 0,
        };
        let name_with_nul = {
            let mut v = library_name.as_bytes().to_vec();
            v.push(0);
            v
        };
        if slack_start + name_with_nul.len() > dynstr_sh.sh_size as usize {
            return Err(Error::from_reason(
                "No room in .dynstr for the library name: cannot add DT_NEEDED without shifting sections. Use LIEF or rebuild the binary with the dependency.",
            ));
        }

        ElfPatchPlan {
            is_64: elf.is_64,
            little_endian: elf.little_endian,
            entry_offset: entry_offset as usize,
            name_file_offset: str_start + slack_start,
            string_offset_in_dynstr: slack_start,
            name_with_nul,
        }
    };

    // 4. Write the name into the slack, then repurpose the DT_DEBUG entry.
    let name_file_offset = plan.name_file_offset;
    bytes[name_file_offset..name_file_offset + plan.name_with_nul.len()]
        .copy_from_slice(&plan.name_with_nul);
    let ctx = if plan.little_endian {
        scroll::LE
    } else {
        scroll::BE
    };
    let d_tag_offset = plan.entry_offset;
    let d_val_offset = d_tag_offset + if plan.is_64 { 8 } else { 4 };
    if plan.is_64 {
        bytes
            .pwrite_with(DT_NEEDED as u64, d_tag_offset, ctx)
            .map_err(|e| Error::from_reason(format!("Failed to write DT_NEEDED tag: {e}")))?;
        bytes
            .pwrite_with(plan.string_offset_in_dynstr as u64, d_val_offset, ctx)
            .map_err(|e| Error::from_reason(format!("Failed to write DT_NEEDED value: {e}")))?;
    } else {
        bytes
            .pwrite_with(DT_NEEDED as u32, d_tag_offset, ctx)
            .map_err(|e| Error::from_reason(format!("Failed to write DT_NEEDED tag: {e}")))?;
        bytes
            .pwrite_with(plan.string_offset_in_dynstr as u32, d_val_offset, ctx)
            .map_err(|e| Error::from_reason(format!("Failed to write DT_NEEDED value: {e}")))?;
    }

    fs::write(elf_path, &bytes)
        .map_err(|e| Error::from_reason(format!("Failed to write patched ELF file: {e}")))?;
    Ok(())
}

/// Everything `inject_elf_dt_needed` needs after the parsed ELF is dropped.
struct ElfPatchPlan {
    is_64: bool,
    little_endian: bool,
    entry_offset: usize,
    name_file_offset: usize,
    string_offset_in_dynstr: usize,
    name_with_nul: Vec<u8>,
}
