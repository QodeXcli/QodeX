# `qodex re`

Static read of a program on this machine. Mach-O (including a `.app`), PE, and ELF. The same read is the `re_inspect` tool.

It also lists a dependency edge for each linked library or import DLL, Shannon entropy of section bytes that sit inside the file that was read, and printable strings (capped). A string that looks like a private key is omitted, not decoded. Fat Mach-O entropy is not claimed, because slice offsets are not the outer file.

It does not decompile, disassemble functions, decrypt FairPlay, patch a check, or recover a license. A signature blob in the header is not a notarization result. A binary Info.plist is reported as unread. A plist or executable that symlinks out of the `.app` is not followed.
