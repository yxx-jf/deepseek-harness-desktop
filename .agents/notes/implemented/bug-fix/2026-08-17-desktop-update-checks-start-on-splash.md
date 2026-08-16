# Agent Note: Desktop update checks start on the splash

Status: implemented

English | [中文](2026-08-17-desktop-update-checks-start-on-splash.zh.md)

## Problem

Desktop update discovery was easy to miss and easy to misread. The app-update check ran fifteen seconds after the main window settled, so a user staring at the startup surface saw nothing about an available update, and the tray's "check for updates" action only queried the app bundle — never the separately published runtime. Publishing a new runtime (the everyday path in this project) therefore left the tray action reporting "already up to date", which read as a broken updater. And when an app update did exist, the flow asked twice (download? then install?), so nothing happened automatically.

A second defect surfaced once an update was accepted: the installer downloaded over a direct GitHub link, which on a flaky direct connection stalls for a long time with no progress surface, so "download" appeared to do nothing. The runtime bootstrap had already solved the same problem with a mirror prefix; the app updater had not.

## Decision

The splash becomes a permanent startup surface and the update check starts on the first frame. `boot()` now creates the splash immediately, wires the auto-updater with an `onUpdateMessage` hook that paints a banner in the splash, and calls `checkForUpdates()` right away instead of after a delay. Runtime bootstrap progress still paints through the same splash; the splash closes once the main window is ready.

The updater flow asks once and then runs to completion:

- **The user confirms the update.** `update-available` asks `发现新版本 vX，是否立即更新？` with `立即更新` / `暂不`. Declining marks the update declined for the session (the next check asks again); accepting starts `downloadUpdate()`.
- **Download gives visible feedback.** During startup the splash banner paints `正在下载新版本… N%` from `download-progress`; with a visible main window a system notification announces the download instead.
- **Accepted updates install without a second prompt.** `update-downloaded` runs `quitAndInstall()` directly — the user already said yes, so restarting is the promised behavior.
- **Failure is reported.** A failed download pops an error dialog with the release URL so the user can install manually instead of staring at nothing.
- **The download uses the mirror.** `setupAutoUpdater` points electron-updater at a generic feed backed by the same CDN prefix as the runtime (`DSH_APP_UPDATE_URL`, defaulting to the dsh-dist `v0.1.0` release through the mirror). Publishing an installer uploads `latest.yml`, the installer, and its blockmap beside the runtime manifest; the generic feed reads them there.
- **The tray action checks both channels.** "检查更新…" still runs the app-bundle check, and now also calls `checkRuntimeForUpdates()`, which fetches the runtime manifest and compares it to the installed version; a newer runtime offers an immediate restart (the next launch downloads it), while a matching version stays silent.

`runtime-bootstrap` exports `fetchRuntimeManifest(url, fetchImpl)` so the tray path reuses the same fetch-and-validate step the bootstrap runs.

## Alternatives considered

- **Keeping the delayed startup check.** The update prompt arrived after the main window was busy; a user who launched and walked away never saw it.
- **Keeping the two-step confirmation for downloads.** The report was that nothing happened automatically; the download step was the first thing to make automatic, with the restart remaining gated only when a window is already visible. It was then reversed: the user-facing requirement is to be asked once (`是` updates to the end, `否` stays on the current version), not to have downloads happen unprompted.
- **Downloading through the GitHub provider directly.** This is the reported stall: a direct GitHub link is slow or flaky on this network and offered no progress, so the accepted download looked dead. The generic mirror feed reuses the runtime's proven mirror path.
- **Reporting runtime staleness through the app-update channel.** The runtime is a different artifact with its own version stream; folding it into electron-updater would fabricate app releases. The tray action reports each channel on its own terms instead.
- **Restarting automatically without asking.** A spontaneous restart discards an active session's work; the flow asks once up front, so the restart after acceptance is expected rather than surprising.

## Consequences

Launching the app shows the splash for every start (previously only while a runtime download ran), checks for an app update immediately, and — on acceptance — downloads through the mirror with visible progress and installs by restarting. Declining keeps the current version for the session. The tray's "check for updates" now covers both the app bundle and the remote runtime, so publishing either artifact surfaces on the same action. Publishing an app version now uploads the installer triple (`latest.yml`, installer, blockmap) both to the GitHub release (manual installs) and to the dsh-dist release that backs the generic feed (in-app updates). The splash banner is a repaint-only addition; the runtime progress bar and phases are unchanged. The extra export `fetchRuntimeManifest` is covered by `runtime-bootstrap.spec`.
