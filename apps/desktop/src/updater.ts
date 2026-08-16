/** In-app self-update (the app bundle, not the runtime) via GitHub Releases. */

import { dialog, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/** Window access for update dialogs; dialogs fall back to app-modal. */
export interface UpdaterHooks {
  readonly getWindow: () => BrowserWindow | undefined
}

/** Hooks captured by {@link setupAutoUpdater}, reused by {@link checkForUpdates}. */
let hooks: UpdaterHooks | undefined

/** Whether the last check was explicit (report "up to date" only then). */
let notifyNotAvailable = false

/** Show a message box, parenting to the main window when one exists. */
function showMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const window = hooks?.getWindow()
  return window === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options)
}

/**
 * Wire electron-updater to the GitHub Releases source declared in the build
 * config. This updates the app bundle (the installer), which is separate from
 * the runtime bootstrap: both run on startup and via the tray action.
 * @param updaterHooks - Callbacks the updater needs to reach the main window.
 */
export function setupAutoUpdater(updaterHooks: UpdaterHooks): void {
  hooks = updaterHooks
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  console.info('desktop updater: wired (github provider, silent startup check)')

  autoUpdater.on('update-available', (info) => {
    console.info(`desktop update available: ${info.version}`)
    void showMessage({
      type: 'info',
      title: '发现新版本',
      message: `DeepSeek Harness Desktop 有新版本可用：${info.version}`,
      detail: '是否现在下载并安装？',
      buttons: ['下载', '以后再说'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) void autoUpdater.downloadUpdate()
    })
  })

  autoUpdater.on('update-not-available', () => {
    console.info('desktop update: already up to date')
    if (!notifyNotAvailable) return
    notifyNotAvailable = false
    void showMessage({ type: 'info', title: '检查更新', message: '当前已是最新版本。' })
  })

  autoUpdater.on('update-downloaded', () => {
    console.info('desktop update downloaded; ready to install')
    void showMessage({
      type: 'info',
      title: '更新已就绪',
      message: '新版本已下载完成，是否立即重启安装？',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall()
    })
  })

  autoUpdater.on('error', (error) => {
    console.error('desktop update check failed:', error)
  })
}

/**
 * Check GitHub Releases for a newer installer. In development (unpackaged)
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
