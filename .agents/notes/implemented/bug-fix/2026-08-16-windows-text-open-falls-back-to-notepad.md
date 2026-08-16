# Agent Note: Windows text-document open falls back to Notepad

Status: implemented

English | [中文](2026-08-16-windows-text-open-falls-back-to-notepad.zh.md)

## Problem

The Settings page's "open configuration file" action returned success without opening anything on Windows. The desktop GUI hands a settings document to the Host through `settings.openDocument`, which resolves the path with `prepareDocument()` and opens it with `openNativeTextFile()`. On Windows that path ran `powershell.exe Invoke-Item -LiteralPath <path>` — the same file-association open as the default intent. YAML and JSON documents commonly carry no file association on a fresh Windows account, and `Invoke-Item` then silently does nothing while still exiting 0, so the RPC answered `opened: true` and the client showed no error for a gesture that visibly failed.

## Decision

The Windows `text-editor` intent no longer relies on a file association. `openWindowsTextEditor()` runs `Start-Process -FilePath notepad.exe -ArgumentList <path>` through PowerShell, which materialises the document in Notepad regardless of association and returns before the editor exits, so the `execFile`-based command runner never blocks on the editor's GUI lifetime.

The scope of the change is one branch:

- **The default intent is untouched.** `openWindowsPath()` still uses `Invoke-Item`, so paths with an association (an `.html` bound to a browser, a `.txt` bound to an editor) keep opening through the registered application.
- **WSL keeps the Windows association.** A WSL-resolved path still reaches `openWindowsPath()` through the existing `openWslPath()` translation, because a path on the Windows desktop is exactly the case a file association can serve.

macOS and Linux are unchanged: macOS already bypasses the association with `open -t`, and Linux uses `xdg-open` as before.

## Alternatives considered

- **Keeping `Invoke-Item` for the text-editor intent.** This is the reported defect; no change to the call site can make an unassociated extension open.
- **Spawning `notepad.exe` directly through the command runner.** `execFile` waits for the child to exit, so the open would hang the RPC until the editor closed, and re-opening the same document after Notepad already hosts it would reuse the single instance silently.
- **Configuring a file association at install time.** Registering `.yaml`/`.json` during setup is broader than the harness's job, overrides a user's existing choice, and still needs an editor to point at.

## Consequences

"Open configuration file" and every other text-editor open (open document actions, shell Consumers that hand a text path to the native opener) now visibly open Notepad on Windows even when no association exists. Any existing association for the text format is not consulted for the text-editor intent; the default intent still honours it. The change is confined to the Windows text-editor branch, verified by the `native-path-opener` adapter tests.
