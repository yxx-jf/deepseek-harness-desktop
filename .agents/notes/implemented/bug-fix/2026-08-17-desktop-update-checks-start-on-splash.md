# Agent Note: Desktop update checks start on the splash

Status: implemented

English | [中文](2026-08-17-desktop-update-checks-start-on-splash.zh.md)

## Problem

Desktop update discovery was easy to miss and easy to misread. The app-update check ran fifteen seconds after the main window settled, so a user staring at the startup surface saw nothing about an available update, and the tray's "check for updates" action only queried the app bundle — never the separately published runtime. Publishing a new runtime (the everyday path in this project) therefore left the tray action reporting "already up to date", which read as a broken updater. And when an app update did exist, the flow asked twice (download? then install?), so nothing happened automatically.

A second defect surfaced once an update was accepted: the installer downloaded over a direct GitHub link, which on a flaky direct connection stalls for a long time with no progress surface, so "download" appeared to do nothing. The runtime bootstrap had already solved the same problem with a mirror prefix; the app updater had not.

## Decision

The splash becomes a permanent startup surface and the update check starts on the first frame. `boot()` now creates the splash immediately, wires the auto-updater with an `onUpdateMessage` hook that paints a banner in the splash, and calls `checkForUpdates()` right away instead of after a delay. Runtime bootstrap progress still paints through the same splash; the splash closes once the main window is ready.

The updater flow is a serial sequence decided once, app before runtime:

- **The app check runs first and waits.** `boot()` awaits `checkAppUpdate()` before touching the runtime. The check resolves to a decision: `installing` (the user accepted; the mirror download is running and installs by restarting), `declined` (the user stayed on the current version), or `none` (no newer installer exists, or the check failed). The prompt is `发现新版本 vX，是否立即更新？` with `立即更新` / `暂不`.
- **Declining defers everything.** A declined app update skips the runtime check for this launch too: `ensureRuntime`'s new `skipUpdateCheck` reuses the installed runtime as-is (an absent install still bootstraps, because the app cannot start without a Host). Declining therefore updates nothing at all and the app starts on the current versions.
- **Accepting downloads only the installer.** The runtime check is skipped this launch as well; the install relaunches the app, and that relaunch — now up to date — runs the runtime check. So `是` updates the app first and the runtime on the following launch.
- **No app update means the runtime updates now.** When the app is current, the runtime bootstrap runs as before: it fetches the manifest, downloads in the splash, and installs for the next launch.
- **Update prompts float above the splash.** The splash is always-on-top, so while the main window does not exist the update dialogs parent to the splash window (`getSplash`); otherwise the prompts would be hidden behind it.
- **Download gives visible feedback.** During startup the splash banner paints `正在下载新版本… N%` from `download-progress`; with a visible main window a system notification announces the download instead. A `SplashSurface.setProgress(percent)` method drives a CSS progress bar beneath the message, throttled to one `executeJavaScript` per percentage point.
- **ensureSplash** — the updater may receive an `onUpdateProgress` after the main window is ready (when the splash was already closed). The `ensureSplash` hook re-creates the splash window so the download progress remains visible.
- **Accepted updates install without a second prompt.** `update-downloaded` runs `quitAndInstall()` directly — the user already said yes, so restarting is the promised behavior.
- **Failure is reported.** A failed download pops an error dialog with the release URL so the user can install manually instead of staring at nothing.
- **The download uses the mirror.** `setupAutoUpdater` points electron-updater at a generic feed backed by the same CDN prefix as the runtime (`DSH_APP_UPDATE_URL`, defaulting to the dsh-dist `v0.1.0` release through the mirror). Publishing an installer uploads `latest.yml`, the installer, and its blockmap beside the runtime manifest; the generic feed reads them there.
- **The tray action checks both channels.** "检查更新…" runs `checkAppUpdate(true)` and `checkRuntimeForUpdates()`, which fetches the runtime manifest and compares it to the installed version; a newer runtime offers an immediate restart (the next launch downloads it), while a matching version stays silent.

`runtime-bootstrap` exports `fetchRuntimeManifest(url, fetchImpl)` so the tray path reuses the same fetch-and-validate step the bootstrap runs.

## Alternatives considered

- **Keeping the delayed startup check.** The update prompt arrived after the main window was busy; a user who launched and walked away never saw it.
- **Keeping the two-step confirmation for downloads.** The report was that nothing happened automatically; the download step was the first thing to make automatic, with the restart remaining gated only when a window is already visible. It was then reversed: the user-facing requirement is to be asked once (`是` updates to the end, `否` stays on the current version), not to have downloads happen unprompted.
- **Downloading through the GitHub provider directly.** This is the reported stall: a direct GitHub link is slow or flaky on this network and offered no progress, so the accepted download looked dead. The generic mirror feed reuses the runtime's proven mirror path.
- **Reporting runtime staleness through the app-update channel.** The runtime is a different artifact with its own version stream; folding it into electron-updater would fabricate app releases. The tray action reports each channel on its own terms instead.
- **Restarting automatically without asking.** A spontaneous restart discards an active session's work; the flow asks once up front, so the restart after acceptance is expected rather than surprising.

## Consequences

The startup sequence is now serial and decided once: the app update is checked first and the user decides before anything else happens. Declining updates nothing at all — the app stays on the current version and the runtime check is skipped (`skipUpdateCheck` reuses the installed runtime; only a missing install still bootstraps). Accepting downloads only the installer through the mirror with visible progress and installs by restarting; the relaunch, now up to date, then runs the runtime check. Only when no app update exists does the runtime check run on this launch. Update prompts parent to the always-on-top splash while the main window does not exist, so they are never hidden behind it. The tray's "check for updates" still covers both the app bundle and the remote runtime. Publishing an app version uploads the installer triple (`latest.yml`, installer, blockmap) both to the GitHub release (manual installs) and to the dsh-dist release that backs the generic feed (in-app updates). `skipUpdateCheck` and the still-mandatory bootstrap of a missing runtime are covered by `runtime-bootstrap.spec`.
