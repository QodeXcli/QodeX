# `qodex re`

Static read of a program on this machine. Mach-O (including a `.app`), PE, and ELF. The same read is the `re_inspect` tool.

It reports architecture, kind, linked libraries, rpaths, section names, PE import DLL names, a Mach-O uuid, a minimum OS when the load command is there, and whether an encryption command says the image is encrypted.

It does not decompile, disassemble functions, decrypt FairPlay, patch a check, or recover a license. A signature blob in the header is not a notarization result. A binary Info.plist is reported as unread. A plist or executable that symlinks out of the `.app` is not followed.
