/** In-app self-update (the app bundle, not the runtime) via a mirror feed. */

import { app, dialog, Notification, type BrowserWindow } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'

/** Window access for update dialogs; dialogs fall back to app-modal. */
export interface UpdaterHooks {
  readonly getWindow: () => BrowserWindow | undefined
  /** Preferred modal parent while the main window does not exist (the splash). */
  readonly getSplash?: () => BrowserWindow | undefined
  /** Receive update-status text for the startup splash; no-op after it closes. */
  readonly onUpdateMessage?: (message: string) => void
  /** Receive download percentage for the splash progress bar. */
  readonly onUpdateProgress?: (percent: number) => void
  /** Show a download surface (splash) even when the main window is already open. */
  readonly ensureSplash?: () => void
}

/** Outcome of one app-update check for the startup sequence. */
export type AppUpdateDecision = 'none' | 'declined' | 'installing'

/** Hooks captured by {@link setupAutoUpdater}, reused by {@link checkAppUpdate}. */
let hooks: UpdaterHooks | undefined

/** Last percent reported by the download-progress event (throttle the splash). */
let lastReportedPercent = -1

/** Whether the user accepted the pending update in this session. */
let updateAccepted = false

/** Show a message box, parenting to the main window when one exists, else the splash. */
function showMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const parent = hooks?.getWindow() ?? hooks?.getSplash?.()
  return parent === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options)
}

/** Whether the main window is currently visible (an active session exists). */
function mainVisible(): boolean {
  const window = hooks?.getWindow()
  return window !== undefined && !window.isDestroyed() && window.isVisible()
}

/**
 * Wire electron-updater to a generic mirror feed (the same mirror that serves
 * the runtime, so the installer downloads at mirror speed instead of stalling
 * on a direct GitHub link). This only wires download progress and the accepted
 * install; check decisions are driven per-call by {@link checkAppUpdate}.
 * @param updaterHooks - Callbacks the updater needs to reach the window and the splash.
 * @param feedUrl - Generic mirror base URL with latest.yml and installers; omitted in development.
 */
export function setupAutoUpdater(updaterHooks: UpdaterHooks, feedUrl?: string): void {
  hooks = updaterHooks
  lastReportedPercent = -1
  updateAccepted = false
  if (feedUrl !== undefined && feedUrl.length > 0) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // The project ships prerelease builds (0.1.0-rc.x); without this the
  // prerelease channel is ignored and no update is ever offered.
  autoUpdater.allowPrerelease = true
  console.info(`desktop updater: wired (${feedUrl === undefined ? 'github provider' : 'generic mirror feed'}, user-confirmed updates)`)

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent)
    if (percent === lastReportedPercent) return
    lastReportedPercent = percent
    hooks?.onUpdateProgress?.(percent)
    hooks?.onUpdateMessage?.(`正在下载新版本… ${percent}%`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    if (!updateAccepted) return
    console.info(`desktop update downloaded; installing: ${info.version}`)
    hooks?.onUpdateMessage?.(`新版本 v${info.version} 已下载，正在重启安装…`)
    if (mainVisible()) {
      new Notification({ title: '更新完成', body: '新版本已下载，正在重启安装…' }).show()
    }
    // The user already accepted the update, so no second prompt: restart and
    // let the NSIS installer replace the app (it relaunches on completion).
    autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (error) => {
    console.error('desktop update check failed:', error)
  })
}

/**
 * Check the mirror feed for a newer installer and let the user decide. The
 * returned decision drives the startup sequence: `installing` means an
 * accepted download is running (install restarts the app on completion),
 * `declined` means the user stayed on the current version for this session,
 * and `none` means no newer installer exists or the check failed.
 * @param notifyWhenCurrent - Report "already up to date" when no update exists.
 * @returns The startup decision.
 */
export function checkAppUpdate(notifyWhenCurrent = false): Promise<AppUpdateDecision> {
  // electron-updater skips the check entirely in development (unpackaged)
  // and emits no event, which would leave the returned promise pending
  // forever and stall the startup sequence on the splash. Resolve 'none'
  // immediately so the app always starts in development.
  if (typeof app !== 'undefined' && !app.isPackaged) {
    console.info('desktop update check skipped (unpackaged)')
    return Promise.resolve('none')
  }
  return new Promise<AppUpdateDecision>((resolve) => {
    let settled = false
    let detach: () => void = () => {}

    // If the upstream feed is unreachable (slow network, proxy, or server
    // error), the check may hang without emitting any event. A timeout
    // prevents the splash from being stuck on "正在检查更新…" forever.
    const timeout = setTimeout(() => {
      console.warn('desktop update check timed out; proceeding with startup')
      settled = true
      detach()
      resolve('none')
    }, 10_000)

    const settle = (decision: AppUpdateDecision): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      detach()
      resolve(decision)
    }

    const onAvailable = (info: UpdateInfo): void => {
      detach()
      console.info(`desktop update available: ${info.version}`)
      hooks?.onUpdateMessage?.(`发现新版本 v${info.version}`)
      void showMessage({
        type: 'question',
        title: '发现新版本',
        message: `发现新版本 v${info.version}，是否立即更新？`,
        detail: '选择“立即更新”将下载新版本并自动重启安装；选择“暂不”将不更新任何内容，直接启动。',
        buttons: ['立即更新', '暂不'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response !== 0) {
          settle('declined')
          return
        }
        updateAccepted = true
        // Force a download surface: the splash covers the main window with a
        // live progress bar, so the user sees the download either way.
        hooks?.ensureSplash?.()
        hooks?.onUpdateProgress?.(0)
        hooks?.onUpdateMessage?.(`正在下载新版本 v${info.version}…`)
        if (mainVisible()) {
          // An active session sees the download through a system notification;
          // during startup the splash paints the same message as a banner.
          new Notification({ title: '正在下载更新', body: `正在下载新版本 v${info.version}…` }).show()
        }
        void autoUpdater.downloadUpdate().catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error)
          console.error('desktop update download failed:', error)
          hooks?.onUpdateMessage?.(`新版本下载失败：${detail}`)
          void showMessage({
            type: 'error',
            title: '下载更新失败',
            message: '新版本下载失败，请稍后重试。',
            detail: `${detail}\n\n也可以从 GitHub Release 手动下载安装包：\nhttps://github.com/yxx-jf/deepseek-harness-desktop/releases`,
          })
        })
        settle('installing')
      })
    }
    const onNotAvailable = (): void => {
      console.info('desktop update: already up to date')
      if (notifyWhenCurrent) {
        void showMessage({ type: 'info', title: '检查更新', message: '当前已是最新版本。' })
      }
      settle('none')
    }
    const onError = (error: unknown): void => {
      console.error('desktop update check failed:', error)
      settle('none')
    }

    autoUpdater.once('update-available', onAvailable)
    autoUpdater.once('update-not-available', onNotAvailable)
    autoUpdater.once('error', onError)
    detach = () => {
      autoUpdater.removeListener('update-available', onAvailable)
      autoUpdater.removeListener('update-not-available', onNotAvailable)
      autoUpdater.removeListener('error', onError)
    }

    console.info('desktop update check starting')
    autoUpdater.checkForUpdates().catch((error: unknown) => {
      console.error('desktop update check failed:', error)
      settle('none')
    })
  })
}
