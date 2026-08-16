# Agent Note: Desktop update checks start on the splash

Status: implemented

English | [中文](2026-08-17-desktop-update-checks-start-on-splash.zh.md)

## Problem

Desktop update discovery was easy to miss and easy to misread. The app-update check ran fifteen seconds after the main window settled, so a user staring at the startup surface saw nothing about an available update, and the tray's "check for updates" action only queried the app bundle — never the separately published runtime. Publishing a new runtime (the everyday path in this project) therefore left the tray action reporting "already up to date", which read as a broken updater. And when an app update did exist, the flow asked twice (download? then install?), so nothing happened automatically.

## Decision

The splash becomes a permanent startup surface and the update check starts on the first frame. `boot()` now creates the splash immediately, wires the auto-updater with an `onUpdateMessage` hook that paints a banner in the splash, and calls `checkForUpdates()` right away instead of after a delay. Runtime bootstrap progress still paints through the same splash; the splash closes once the main window is ready.

The updater flow is automatic where nothing can be lost, and gated where it can:

- **Download is never asked about.** `update-available` starts `downloadUpdate()` immediately and reports `发现新版本 vX，正在自动下载…` through the splash; `download-progress` repaints the banner.
- **Install is automatic during startup.** `update-downloaded` installs with `quitAndInstall()` on its own while the main window does not exist yet — there is no user work to discard. Once a main window is visible, the same event asks `是否立即重启安装？` before restarting.
- **The tray action checks both channels.** "检查更新…" still runs the app-bundle check, and now also calls `checkRuntimeForUpdates()`, which fetches the runtime manifest and compares it to the installed version; a newer runtime offers an immediate restart (the next launch downloads it), while a matching version stays silent.

`runtime-bootstrap` exports `fetchRuntimeManifest(url, fetchImpl)` so the tray path reuses the same fetch-and-validate step the bootstrap runs.

## Alternatives considered

- **Keeping the delayed startup check.** The update prompt arrived after the main window was busy; a user who launched and walked away never saw it.
- **Keeping the two-step confirmation for downloads.** The report was that nothing happened automatically; the download step was the first thing to make automatic, with the restart remaining gated only when a window is already visible.
- **Reporting runtime staleness through the app-update channel.** The runtime is a different artifact with its own version stream; folding it into electron-updater would fabricate app releases. The tray action reports each channel on its own terms instead.
- **Always restarting on `update-downloaded`.** During an active session a spontaneous restart discards work, so the automatic path is reserved for the pre-window startup phase.

## Consequences

Launching the app shows the splash for every start (previously only while a runtime download ran), checks for an app update immediately, and installs it automatically before the main window exists. The tray's "check for updates" now covers both the app bundle and the remote runtime, so publishing either artifact surfaces on the same action. The splash banner is a repaint-only addition; the runtime progress bar and phases are unchanged. The extra export `fetchRuntimeManifest` is covered by `runtime-bootstrap.spec`.
