/** Frameless progress window shown while the remote Host runtime installs. */

import { BrowserWindow } from 'electron'
import type { BootstrapProgress } from './runtime-bootstrap.ts'

const SPLASH_WIDTH = 520
const SPLASH_HEIGHT = 380

/** A splash window that renders bootstrap progress. */
export interface SplashSurface {
  /** Repaint the progress bar and status text for one observation. */
  update(progress: BootstrapProgress): void
  /** Show or replace the update banner (an empty string hides it). */
  setMessage(message: string): void
  /** Destroy the window. */
  close(): void
}

/** Status line for one bootstrap phase; the percentage renders separately. */
function statusText(progress: BootstrapProgress): string {
  switch (progress.phase) {
    case 'fetching-manifest':
      return '正在检查更新…'
    case 'downloading':
      return '正在下载运行环境…'
    case 'extracting':
      return '正在解压运行环境…'
    case 'installing':
      return '正在安装运行环境…'
    case 'ready':
      return '运行环境就绪'
  }
}

/** Render a bootstrap detail line in Chinese; the bootstrap keeps neutral English text. */
function detailText(raw: string | undefined): string {
  if (raw === undefined) return ''
  const attempt = /^attempt (\d+) of (.+)$/u.exec(raw)
  if (attempt !== null) return `第 ${attempt[1]} 次尝试：${attempt[2]}`
  return raw
}

/**
 * Create a dark, frameless splash window over the given HTML file and drive
 * it by patching the DOM from the main process (the page holds no scripts).
 * @param htmlPath - Local HTML file rendered by the window.
 * @returns The splash surface; the window shows once the file has loaded.
 */
export function createSplashWindow(htmlPath: string): SplashSurface {
  const window = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    frame: false,
    // Drop the Windows Aero border line and keep the OS drop shadow, so the
    // frameless splash floats with a soft shadow instead of a visible frame.
    thickFrame: false,
    hasShadow: true,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  void window.loadFile(htmlPath).then(() => {
    if (!window.isDestroyed()) window.show()
  })

  let lastKey = ''
  let lastBanner: string | undefined

  return {
    update(progress) {
      if (window.isDestroyed()) return
      // Repaint only when the observation changes; extraction reports the
      // same percentage many times, and every repaint runs a page script.
      const key = `${progress.phase}:${progress.percent ?? ''}:${progress.detail ?? ''}`
      if (key === lastKey) return
      lastKey = key
      const percent = progress.percent ?? 0
      // executeJavaScript runs in the page's global lexical scope, so `const`
      // names must be block-scoped to survive repeated updates.
      const script = `(() => {
        document.documentElement.dataset.phase = ${JSON.stringify(progress.phase)};
        const fill = document.getElementById('progress-fill');
        if (fill !== null) fill.style.width = ${JSON.stringify(`${percent}%`)};
        const label = document.getElementById('progress-label');
        if (label !== null) label.textContent = ${JSON.stringify(statusText(progress))};
        const pct = document.getElementById('progress-percent');
        if (pct !== null) pct.textContent = ${JSON.stringify(progress.percent === undefined ? '' : `${percent}%`)};
        const detail = document.getElementById('progress-detail');
        if (detail !== null) detail.textContent = ${JSON.stringify(detailText(progress.detail))};
      })()`
      // The window may be destroyed (app quit) between scheduling and running; nothing to paint then.
      void window.webContents.executeJavaScript(script).catch(() => {})
    },
    setMessage(message) {
      if (window.isDestroyed()) return
      if (message === lastBanner) return
      lastBanner = message
      const script = `(() => {
        const banner = document.getElementById('update-banner');
        if (banner !== null) {
          banner.textContent = ${JSON.stringify(message)};
          banner.style.display = ${JSON.stringify(message === '' ? 'none' : 'block')};
        }
      })()`
      void window.webContents.executeJavaScript(script).catch(() => {})
    },
    close() {
      if (!window.isDestroyed()) window.destroy()
    },
  }
}
