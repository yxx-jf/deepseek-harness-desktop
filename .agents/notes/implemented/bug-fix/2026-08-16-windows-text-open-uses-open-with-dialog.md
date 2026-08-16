# Agent Note: Windows text-document open falls back to the Open With dialog

Status: implemented

English | [中文](2026-08-16-windows-text-open-uses-open-with-dialog.zh.md)

## Problem

The Settings page's "open configuration file" action returned success without opening anything on Windows. The desktop GUI hands a settings document to the Host through `settings.openDocument`, which resolves the path with `prepareDocument()` and opens it with `openNativeTextFile()`. On Windows that path ran `powershell.exe Invoke-Item -LiteralPath <path>` — the same file-association open as the default intent. YAML and JSON documents commonly carry no file association on a fresh Windows account, and `Invoke-Item` then silently does nothing while still exiting 0, so the RPC answered `opened: true` and the client showed no error for a gesture that visibly failed.

## Decision

The Windows `text-editor` intent no longer depends on a file association and no longer hard-codes an editor. `openWindowsTextEditor()` first reads the `UserChoice` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\<ext>`:

- **An association exists** (a `ProgId` is recorded) — `Invoke-Item -LiteralPath <path>` opens the document with the registered application, honouring an editor the user already chose for the format.
- **No association exists** — `rundll32.exe shell32.dll,OpenAs_RunDLL <short path>` shows the Windows "Open With" dialog so the user picks a program. Windows then records the choice as the association, so the next open takes the `Invoke-Item` branch.

rundll32's `OpenAs_RunDLL` truncates its argument at the first space, which makes the dialog flash away on a spaced path, so the dialog branch resolves the 8.3 short path (`Scripting.FileSystemObject`'s `ShortPath`) first; a short path never contains spaces. The dialog is hosted by the shell, so rundll32 exits before the user finishes choosing and the `execFile`-based runner never blocks on the dialog lifetime.

The scope of the change is one branch:

- **The default intent is untouched.** `openWindowsPath()` still uses `Invoke-Item`, so paths with an association (an `.html` bound to a browser, a `.txt` bound to an editor) keep opening through the registered application.
- **WSL keeps the Windows association.** A WSL-resolved path still reaches `openWindowsPath()` through the existing `openWslPath()` translation, because a path on the Windows desktop is exactly the case a file association can serve.

macOS and Linux are unchanged: macOS already bypasses the association with `open -t`, and Linux uses `xdg-open` as before.

## Alternatives considered

- **Hard-coding Notepad (the first shipped fix).** It opened the document reliably without an association, but it overrode an existing association and gave the user no choice of editor; the Open With dialog replaced it.
- **Calling `OpenAs_RunDLL` with the original path.** Reliable without spaces, but the dialog flashes away on a spaced path (a user profile under a name containing a space), which is exactly the machine a first-run YAML open can land on.
- **Double-quoting the spaced path.** Also closes the dialog in practice; only the space-free short path stays reliable.
- **Configuring a file association at install time.** Registering `.yaml`/`.json` during setup is broader than the harness's job, overrides a user's existing choice, and still needs an editor to point at.

## Consequences

"Open configuration file" and every other text-editor open (open document actions, shell Consumers that hand a text path to the native opener) now open the document through the association when one exists, and otherwise show the Windows Open With dialog so the user chooses — after which Windows remembers the association and later opens go straight to the chosen editor. The change is confined to the Windows text-editor branch, verified by the `native-path-opener` adapter tests. When 8.3 name creation is disabled system-wide, `ShortPath` returns the original path and a spaced path can still hit rundll32's truncation; the common configuration-file location (`%USERPROFILE%\.dsh`) rarely contains a space.
