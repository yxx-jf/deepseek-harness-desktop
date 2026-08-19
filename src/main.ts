/** Electron application shell for the loopback DeepSeek Harness Web Host. */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  session,
  shell,
  Tray,
  type Event,
  type MenuItemConstructorOptions,
} from 'electron'
import { ensureRuntime, extractZip, fetchRuntimeManifestWithMirrors, readInstalledVersion } from './runtime-bootstrap.ts'
import { extractZipParallel } from './parallel-extract.ts'
import { createSplashWindow, type SplashSurface } from './splash.ts'
import { createHostSupervisor, spawnDshWeb, type HostSupervisor } from './host-supervisor.ts'
import { createInstallerWatch, hasInstallerRow, type InstallerWatch } from './installer-watch.ts'
import { createDesktopLifecycle, type DesktopLifecycle } from './window-lifecycle.ts'
import { checkAppUpdate, setupAutoUpdater } from './updater.ts'

const APP_NAME = 'DeepSeek Harness'
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 920
const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(DESKTOP_DIR, '../..')
/** Path of the Host CLI entry relative to a runtime root (checkout, bundled, or downloaded). */
const HOST_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
/** Image-name prefix of the NSIS installer artifacts (`DeepSeek-Harness-<version>-<arch>.exe`). */
const INSTALLER_PROCESS_PATTERN = 'DeepSeek-Harness*'
/** Poll cadence for the installer watcher (milliseconds). */
const INSTALLER_POLL_INTERVAL_MS = 1_000

/** Resolved artifacts needed to launch the desktop Host process. */
interface HostPaths {
  readonly nodeExecutable: string
  readonly cliEntry: string
  readonly cwd: string
  readonly electronRunAsNode: boolean
}

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let host: HostSupervisor | undefined
let lifecycle: DesktopLifecycle | undefined
let hostOrigin: string | undefined
let bootQuitPromise: Promise<void> | undefined
let quitReleased = false
let installerWatch: InstallerWatch | undefined
let activeSplash: SplashSurface | undefined

/** Resolve artifacts from the checkout in development and a runtime root when packaged. */
function hostPaths(runtimeRoot: string): HostPaths {
  if (!app.isPackaged) {
    return {
      nodeExecutable: process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? 'node',
      cliEntry: join(runtimeRoot, 'apps/cli/lib/bin.js'),
      cwd: process.cwd(),
      electronRunAsNode: false,
    }
  }
  return {
    nodeExecutable: process.execPath,
    cliEntry: join(runtimeRoot, HOST_ENTRY),
    cwd: app.getPath('home'),
    electronRunAsNode: true,
  }
}

/**
 * URL of the remote runtime manifest, or undefined when the bundled runtime
 * is authoritative. The environment variable wins; a packaged build reads a
 * config file written by the runtime publisher into desktop-resources.
 */
function packagedManifestUrl(): string | undefined {
  const fromEnv = process.env.DSH_RUNTIME_MANIFEST_URL
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  if (!app.isPackaged) return undefined
  const configPath = join(process.resourcesPath, 'desktop-resources/runtime-config.json')
  if (!existsSync(configPath)) return undefined
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { manifestUrl?: unknown }
  if (typeof config.manifestUrl !== 'string' || config.manifestUrl.length === 0) {
    throw new Error(`desktop runtime config has no manifestUrl: ${configPath}`)
  }
  return config.manifestUrl
}

/** Path of the bundled splash HTML, from the checkout in development or desktop-resources when packaged. */
function splashHtmlPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'desktop-resources/splash.html')
    : join(DESKTOP_DIR, 'resources/splash.html')
}

/** Path of the sandboxed preload bridge, from the checkout in development or desktop-resources when packaged. */
function preloadPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'desktop-resources/preload.cjs')
    : join(DESKTOP_DIR, 'resources/preload.cjs')
}

/** Accept one of the three theme-source values electron-updater's nativeTheme understands. */
function isThemeSource(value: unknown): value is 'light' | 'dark' | 'system' {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * Wire the renderer's optional desktop bridge: mirror the app theme onto the
 * native chrome. `nativeTheme.themeSource` drives Windows title-bar dark
 * mode through DWM, so the window chrome follows the in-app theme choice.
 */
function wireDesktopBridge(): void {
  ipcMain.handle('desktop:set-native-theme', (_event, source: unknown) => {
    if (isThemeSource(source)) nativeTheme.themeSource = source
  })
}

/**
 * Mirror base URL that hosts the app installers and `latest.yml`, used as the
 * generic update feed. The mirror serves the same CDN prefix as the runtime,
 * so the installer downloads at mirror speed instead of stalling on a direct
 * GitHub link. The environment variable overrides the default.
 */
function appUpdateFeedUrl(): string | undefined {
  if (!app.isPackaged) return undefined
  return process.env.DSH_APP_UPDATE_URL ?? 'https://github.akams.cn/https://github.com/yxx-jf/deepseek-harness-desktop/releases/download/v0.1.0-rc.12/'
}

/**
 * Resolve the Host paths for this launch. In development the checkout is the
 * runtime. Packaged, the bundled runtime is authoritative unless a remote
 * manifest URL is configured, in which case the runtime is bootstrapped into
 * the user data directory first (showing a splash while it downloads). When
 * {@link skipRuntimeUpdate} is set the installed runtime is used as-is unless
 * nothing is installed yet.
 */
async function resolveHostPaths(splash: SplashSurface | undefined, skipRuntimeUpdate: boolean): Promise<HostPaths> {
  if (!app.isPackaged) {
    // In development, prefer the upstream clone when this is a standalone
    // desktop repo (deepseek-harness-desktop). Fall back to the monorepo
    // checkout layout (desktop sits at apps/desktop inside the full repo).
    const upstreamRoot = join(DESKTOP_DIR, 'upstream')
    if (existsSync(upstreamRoot)) return hostPaths(upstreamRoot)
    return hostPaths(REPOSITORY_ROOT)
  }
  const manifestUrl = packagedManifestUrl()
  if (manifestUrl === undefined) return hostPaths(join(process.resourcesPath, 'host'))
  const runtimeDir = join(app.getPath('userData'), 'host')
  const outcome = await ensureRuntime({
    manifestUrl,
    runtimeDir,
    hostEntry: HOST_ENTRY,
    // Chromium's network stack (Electron net.fetch) validates certificates
    // against the OS store and honors system proxy settings. Node's bundled
    // CA fetch rejects machines with locally installed roots (intercepting
    // proxies, security suites), so the runtime download must not use it.
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    // Flaky links to release CDNs stall mid-stream; abort a stalled attempt
    // and retry, then fall back to mirror prefixes that prepend to the
    // archive URL (the manifest SHA-256 gates every attempt).
    downloadStallTimeoutMs: 20_000,
    downloadRetries: 1,
    mirrorPrefixes: (process.env.DSH_RUNTIME_MIRRORS ?? 'https://github.akams.cn/')
      .split(',')
      .map(mirror => mirror.trim())
      .filter(mirror => mirror.length > 0),
    // Parallel workers inflate and write concurrently; the serial path is
    // the fallback for archives or environments the parallel path cannot
    // handle (the serial extractor re-creates the destination first).
    extractArchive: async (archivePath, destination, onBytes) => {
      try {
        await extractZipParallel(archivePath, destination, onBytes)
      } catch (error) {
        console.warn('desktop parallel extraction failed; falling back to serial:', error)
        await extractZip(archivePath, destination, onBytes)
      }
    },
    onProgress: (progress) => { splash?.update(progress) },
    skipUpdateCheck: skipRuntimeUpdate,
  })
  return hostPaths(outcome.runtimeDir)
}

function assertHostArtifacts(paths: HostPaths): void {
  if (paths.nodeExecutable.includes('/') && !existsSync(paths.nodeExecutable)) {
    throw new Error(`desktop Node runtime is missing: ${paths.nodeExecutable}`)
  }
  if (!existsSync(paths.cliEntry)) {
    throw new Error(`desktop Host entry is missing: ${paths.cliEntry}; run pnpm run build first`)
  }
}

/** Load the app-local tray icon, with an empty fallback for incomplete staging. */
function trayImage(): Electron.NativeImage {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'desktop-resources/trayTemplate.png')]
    : [join(DESKTOP_DIR, 'resources/trayTemplate.png')]
  const path = candidates.find(candidate => existsSync(candidate))
  const image = path === undefined ? nativeImage.createEmpty() : nativeImage.createFromPath(path)
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

function isExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Report whether an NSIS installer for this application is currently running. */
function isInstallerRunning(callback: (running: boolean) => void): void {
  const tasklist = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe')
  execFile(tasklist, ['/FI', `IMAGENAME eq ${INSTALLER_PROCESS_PATTERN}`, '/FO', 'CSV', '/NH'], (error, stdout) => {
    callback(error === null && hasInstallerRow(stdout))
  })
}

function hasOrigin(raw: string, expected: string): boolean {
  try {
    return new URL(raw).origin === expected
  } catch {
    return false
  }
}

/** Permissions the renderer may hold; every other permission stays denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-write'])

/** Install navigation and permission policy before the first renderer loads. */
function hardenSession(): void {
  const desktopSession = session.defaultSession
  const allowed = (permission: string): boolean => ALLOWED_PERMISSIONS.has(permission)
  desktopSession.setPermissionCheckHandler((_webContents, permission) => allowed(permission))
  desktopSession.setPermissionRequestHandler((_webContents, permission, callback) => { callback(allowed(permission)) })
}

async function createMainWindow(): Promise<BrowserWindow> {
  const origin = hostOrigin
  if (origin === undefined) throw new Error('desktop Host is not ready')
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME,
    icon: join(DESKTOP_DIR, 'build/icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: preloadPath(),
    },
  })
  mainWindow = window
  window.on('close', (event) => { lifecycle?.onWindowClose(event) })
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (hasOrigin(url, origin)) return
    event.preventDefault()
    if (isExternalUrl(url)) void shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  await window.loadURL(origin)
  if (!lifecycle?.isQuitting) window.show()
  return window
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip(APP_NAME)
  const template: MenuItemConstructorOptions[] = [
    { label: '打开主窗口', click: () => { void lifecycle?.showWindow() } },
    { label: '检查更新…', click: () => { void checkAppUpdate(true); void checkRuntimeForUpdates() } },
    { type: 'separator' },
    { label: '退出', click: () => { void requestAppQuit() } },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.on('click', () => { void lifecycle?.showWindow() })
}

function releaseAppQuit(): void {
  quitReleased = true
  installerWatch?.stop()
  tray?.destroy()
  tray = undefined
  app.quit()
}

/** Join explicit quit requests even while the Host or window is still starting. */
function requestAppQuit(): Promise<void> {
  if (lifecycle !== undefined) return lifecycle.requestQuit()
  bootQuitPromise ??= (host?.shutdown() ?? Promise.resolve()).catch((error: unknown) => {
    console.error('desktop shutdown failed:', error)
  }).then(() => {
    releaseAppQuit()
  })
  return bootQuitPromise
}

async function boot(): Promise<void> {
  if (bootQuitPromise !== undefined) return
  wireDesktopBridge()
  // The splash doubles as the startup surface: update prompts are parented to
  // it (so they float above its always-on-top window) and it paints download
  // and bootstrap progress.
  const splash = createSplashWindow(splashHtmlPath())
  activeSplash = splash
  setupAutoUpdater({
    getWindow: () => mainWindow,
    getSplash: () => activeSplash?.getWindow(),
    onUpdateMessage: (message) => { activeSplash?.setMessage(message) },
    onUpdateProgress: (percent) => { activeSplash?.setProgress(percent) },
    ensureSplash: () => {
      if (activeSplash === undefined) {
        activeSplash = createSplashWindow(splashHtmlPath())
      }
    },
  }, appUpdateFeedUrl())
  // Serial update sequence: decide the app update first, then the runtime.
  // Accepting or declining the app update skips the runtime check this launch
  // — an accepted install relaunches the app, and that relaunch (now up to
  // date) runs the runtime check. Only when no app update exists does the
  // runtime check run now. Declining therefore updates nothing at all.
  const decision = await checkAppUpdate(false)
  if (decision === 'installing') {
    // Splash stays open painting download progress (onUpdateMessage).
    // update-downloaded → quitAndInstall() closes the app naturally.
    // The tray is created later, but the user should not need it during
    // a download; the splash is always-on-top and the download completes
    // on its own. If the download fails, the updater shows an error dialog
    // and the user can quit from the tray (which is created below).
    createTray()
    return
  }
  const skipRuntimeUpdate = decision !== 'none'
  try {
    const paths = await resolveHostPaths(splash, skipRuntimeUpdate)
    assertHostArtifacts(paths)
    host = createHostSupervisor({
      spawnHost: () => spawnDshWeb({
        ...paths,
        env: {
          ...process.env,
          DSH_DESKTOP: '1',
        },
      }),
      log: chunk => process.stderr.write(chunk),
      onUnexpectedExit: ({ code, signal }) => {
        console.error(`desktop Host exited unexpectedly (code ${String(code)}, signal ${String(signal)})`)
        void requestAppQuit()
      },
    })
    hostOrigin = await host.start()
    hardenSession()
    lifecycle = createDesktopLifecycle({
      getWindow: () => mainWindow,
      createWindow: createMainWindow,
      disposeHost: async () => { await host?.shutdown() },
      quit: releaseAppQuit,
      reportError: (error) => { console.error('desktop shutdown failed:', error) },
    })
    createTray()
    // Quit ourselves as soon as the NSIS installer starts: the installer cannot
    // always force-kill a running app (an elevated app, or one shielded by
    // security software), while quitting from inside the process needs no kill
    // rights and also guarantees a clean Host shutdown.
    if (app.isPackaged && process.platform === 'win32') {
      installerWatch = createInstallerWatch({
        isInstallerRunning,
        intervalMs: INSTALLER_POLL_INTERVAL_MS,
        onInstallerDetected: () => { void requestAppQuit() },
      })
      installerWatch.start()
    }
    await lifecycle.showWindow()
  } finally {
    activeSplash = undefined
    splash.close()
  }
}

/** Offer a restart when a newer remote runtime is published. */
async function checkRuntimeForUpdates(): Promise<void> {
  const manifestUrl = packagedManifestUrl()
  if (manifestUrl === undefined) return
  const runtimeDir = join(app.getPath('userData'), 'host')
  const mirrors = (process.env.DSH_RUNTIME_MIRRORS ?? 'https://github.akams.cn/')
    .split(',')
    .map(mirror => mirror.trim())
    .filter(mirror => mirror.length > 0)
  try {
    const manifest = await fetchRuntimeManifestWithMirrors(
      manifestUrl,
      (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
      mirrors,
    )
    const installed = await readInstalledVersion(runtimeDir, HOST_ENTRY)
    if (installed === manifest.version) return
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: '发现新的运行环境',
      message: `发现新的运行环境 ${manifest.version}，重启应用后将自动下载更新。`,
      detail: `当前版本：${installed ?? '未知'}。`,
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      app.relaunch()
      void requestAppQuit()
    }
  } catch (error) {
    console.error('desktop runtime update check failed:', error)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { void lifecycle?.showWindow() })
  app.on('activate', () => { void lifecycle?.showWindow() })
  app.on('window-all-closed', () => {
    // Tray and Host own application lifetime on every platform.
  })
  app.on('before-quit', (event: Event) => {
    if (quitReleased) return
    event.preventDefault()
    void requestAppQuit()
  })
  app.whenReady().then(boot).catch(async (error: unknown) => {
    console.error('desktop startup failed:', error)
    if (bootQuitPromise === undefined) {
      await dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} failed to start`,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    await requestAppQuit()
  })
}
