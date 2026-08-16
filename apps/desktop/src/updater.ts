/** In-app self-update (the app bundle, not the runtime) via a mirror feed. */

import { dialog, Notification, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/** Window access for update dialogs; dialogs fall back to app-modal. */
export interface UpdaterHooks {
  readonly getWindow: () => BrowserWindow | undefined
  /** Receive update-status text for the startup splash; no-op after it closes. */
  readonly onUpdateMessage?: (message: string) => void
}

/** Hooks captured by {@link setupAutoUpdater}, reused by {@link checkForUpdates}. */
let hooks: UpdaterHooks | undefined

/** Whether the last check was explicit (report "up to date" only then). */
let notifyNotAvailable = false

/** Last percent reported by the download-progress event (throttle the splash). */
let lastReportedPercent = -1

/** Whether the user accepted the pending update in this session. */
let updateAccepted = false

/** Show a message box, parenting to the main window when one exists. */
function showMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const window = hooks?.getWindow()
  return window === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options)
}

/** Whether the main window is currently visible (an active session exists). */
function mainVisible(): boolean {
  const window = hooks?.getWindow()
  return window !== undefined && !window.isDestroyed() && window.isVisible()
}

/**
 * Wire electron-updater to a generic mirror feed (the same mirror that serves
 * the runtime, so the installer downloads at mirror speed instead of stalling
 * on a direct GitHub link). The app bundle update is separate from the
 * runtime bootstrap; both are checked on startup and via the tray action.
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
  console.info(`desktop updater: wired (${feedUrl === undefined ? 'github provider' : 'generic mirror feed'}, user-confirmed updates)`)

  autoUpdater.on('update-available', (info) => {
    if (updateAccepted) return
    console.info(`desktop update available: ${info.version}`)
    hooks?.onUpdateMessage?.(`发现新版本 v${info.version}`)
    void showMessage({
      type: 'question',
      title: '发现新版本',
      message: `发现新版本 v${info.version}，是否立即更新？`,
      detail: '选择“立即更新”将下载新版本并自动重启安装；选择“暂不”继续使用当前版本。',
      buttons: ['立即更新', '暂不'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response !== 0) return
      updateAccepted = true
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
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent)
    if (percent === lastReportedPercent) return
    lastReportedPercent = percent
    hooks?.onUpdateMessage?.(`正在下载新版本… ${percent}%`)
  })

  autoUpdater.on('update-not-available', () => {
    console.info('desktop update: already up to date')
    if (!notifyNotAvailable) return
    notifyNotAvailable = false
    void showMessage({ type: 'info', title: '检查更新', message: '当前已是最新版本。' })
  })

  autoUpdater.on('update-downloaded', (info) => {
    if (!updateAccepted) return
    console.info(`desktop update downloaded; installing: ${info.version}`)
    hooks?.onUpdateMessage?.(`新版本 v${info.version} 已下载，正在重启安装…`)
    if (mainVisible()) {
      new Notification({ title: '更新完成', body: '新版本已下载，正在重启安装…' }).show()
    }
    // The user already accepted the update, so no second prompt: restart and
    // let the NSIS installer replace the app.
    autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (error) => {
    console.error('desktop update check failed:', error)
  })
}

/**
 * Check the mirror feed for a newer installer. In development (unpackaged)
 * there is no update metadata and the check fails silently unless the caller
 * asks to report errors.
 * @param notifyWhenCurrent - Report "already up to date" when no update exists.
 */
export function checkForUpdates(notifyWhenCurrent = false): void {
  notifyNotAvailable = notifyWhenCurrent
  console.info('desktop update check starting')
  autoUpdater.checkForUpdates().then(() => {
    console.info('desktop update check resolved')
  }).catch((error: unknown) => {
    console.error('desktop update check failed:', error)
    if (notifyWhenCurrent) {
      void showMessage({
        type: 'error',
        title: '检查更新失败',
        message: '无法检查更新，请稍后重试。',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  })
}
