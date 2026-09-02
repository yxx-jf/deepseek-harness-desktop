/** Electron application shell for the loopback DeepSeek Harness Web Host. */

import { execFile, spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
/** Root of DSH user data (`~/.dsh` by default). */
const DSH_HOME = join(homedir(), '.dsh')
/** The web profile manifest/lock directory plugins land in. */
const WEB_PROFILE_DIR = join(DSH_HOME, 'profiles/web')
/** Where Git-hosted repos are cloned for inspecting/installing plugins. */
const PLUGIN_CLONE_DIR = join(DSH_HOME, 'plugins')

/** Resolved artifacts needed to launch the desktop Host process. */
interface HostPaths {
  readonly nodeExecutable: string
  readonly cliEntry: string
  readonly cwd: string
  readonly electronRunAsNode: boolean
}

let mainWindow: BrowserWindow | undefined
let managerWindow: BrowserWindow | undefined
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
    // An empty/absent remote config means the bundled runtime is authoritative
    // (full/offline installer). Fall back to resources/host instead of failing.
    return undefined
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

/** Path of the plugin-manager preload, from the checkout in development or desktop-resources when packaged. */
function pluginManagerPreloadPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'desktop-resources/plugin-manager-preload.cjs')
    : join(DESKTOP_DIR, 'resources/plugin-manager-preload.cjs')
}

/** Path of the plugin-manager HTML, from the checkout in development or desktop-resources when packaged. */
function pluginManagerHtmlPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'desktop-resources/plugin-manager.html')
    : join(DESKTOP_DIR, 'resources/plugin-manager.html')
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
  ipcMain.handle('desktop:get-native-theme', () => nativeTheme.themeSource)
  // Broadcast theme changes to all open plugin-manager windows.
  nativeTheme.on('updated', () => {
    managerWindow?.webContents.send('theme-changed', nativeTheme.themeSource)
  })
  ipcMain.handle('desktop:plugin-list', async (): Promise<{ ok: true; plugins: string[] } | { ok: false; error: string }> => {
    try {
      const pkgPath = join(WEB_PROFILE_DIR, 'package.json')
      if (!existsSync(pkgPath)) return { ok: true, plugins: [] }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
      const bundles = pkg.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) return { ok: true, plugins: [] }
      // Show only user-installed plugins (hide built-in @deepseek-ai/ bundles).
      return { ok: true, plugins: bundles.filter(b => typeof b === 'string' && !b.startsWith('@deepseek-ai/')) as string[] }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('desktop:plugin-resolve', async (_event, address: string): Promise<PluginResult & { candidates?: PluginCandidate[] }> => {
    return resolvePluginAddress(address)
  })
  ipcMain.handle('desktop:plugin-install', async (_event, path: string): Promise<PluginResult> => {
    const pkgPath = join(path, 'package.json')
    if (!existsSync(pkgPath)) return { ok: false, error: '该目录不是有效的插件包（缺少 package.json）' }
    const result = await runDshPlugin(['add', path])
    if (!result.ok) return { ok: false, error: result.message }
    return { ok: true }
  })
  ipcMain.handle('desktop:plugin-uninstall', async (_event, name: string): Promise<PluginResult> => {
    const result = await runDshPlugin(['remove', name])
    if (!result.ok) return { ok: false, error: result.message }
    return { ok: true }
  })
  ipcMain.handle('desktop:open-plugin-manager', (): void => {
    openPluginManager()
  })
  ipcMain.handle('desktop:quit', async (): Promise<void> => {
    app.relaunch()
    void requestAppQuit()
  })
  ipcMain.handle('desktop:plugin-search', async (_event, category: string, query: string, page: number): Promise<{ ok: true; repos: GitHubRepo[]; page: number; totalCount?: number } | { ok: false; error: string }> => {
    if (category !== 'community' && category !== 'theme') return { ok: false, error: 'category 必须是 community 或 theme' }
    const pageNum = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1
    try {
      const result = await searchGitHubRepos(category, query, pageNum)
      if (result.error !== undefined && result.repos.length === 0) return { ok: false, error: result.error }
      return { ok: true, repos: result.repos, page: pageNum, totalCount: result.totalCount }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('desktop:plugin-bundle-check', async (_event, fullName: string, defaultBranch: string): Promise<{ ok: true; reachable: boolean; verified: boolean } | { ok: false; error: string }> => {
    try {
      const result = await dshBundleCheck(fullName, defaultBranch)
      return { ok: true, reachable: result.reachable, verified: result.verified }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('desktop:plugin-repo-readme', async (_event, fullName: string, defaultBranch: string): Promise<{ ok: true; readmeZh?: string; readmeEn?: string } | { ok: false; error: string }> => {
    try {
      const { zh, en } = await fetchRepoReadme(fullName, defaultBranch)
      return { ok: true, readmeZh: zh, readmeEn: en }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('desktop:plugin-subscriptions', async (): Promise<{ ok: true; subscriptions: Record<string, PluginSubscription> }> => {
    return { ok: true, subscriptions: readSubscriptions() }
  })
  ipcMain.handle('desktop:plugin-subscribe', async (_event, repoUrl: string): Promise<PluginResult & { candidates?: PluginCandidate[] }> => {
    try {
      const url = repoUrl.trim()
      if (url === '') return { ok: false, error: '地址为空' }
      // Clone or update the repo.
      const cloned = await cloneRepo(url)
      if (!cloned.ok) return { ok: false, error: cloned.error }
      if (cloned.path === undefined) return { ok: false, error: '克隆成功但未知路径' }
      const candidates = scanForPluginCandidates(cloned.path)
      // Save subscription.
      const subs = readSubscriptions()
      subs[url] = {
        repoUrl: url,
        repoName: repoFolderName(url),
        clonePath: cloned.path,
        enabledBundle: null,
        subscribedAt: new Date().toISOString(),
      }
      writeSubscriptions(subs)
      return { ok: true, candidates }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('desktop:plugin-enable', async (_event, repoUrl: string, bundlePath: string): Promise<PluginResult & { bundleName?: string }> => {
    try {
      const pkgPath = join(bundlePath, 'package.json')
      if (!existsSync(pkgPath)) return { ok: false, error: '该目录不是有效的插件包（缺少 package.json）' }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; main?: unknown; scripts?: { build?: unknown } }
      const bundleName = typeof pkg.name === 'string' ? pkg.name : ''

      // 1) 确保运行时 peer 依赖链接（~/.dsh/node_modules/@deepseek-ai）
      ensurePluginRuntimeLinks()

      // 2) 将插件注册到 profile
      const addResult = await runDshPlugin(['add', bundlePath])
      if (!addResult.ok) return { ok: false, error: `注册失败：${addResult.message}` }

      // 3) 检查并构建（如果主入口文件缺失）
      const mainEntry = typeof pkg.main === 'string' && pkg.main !== '' ? pkg.main : 'lib/index.js'
      const hasBuild = !!(pkg.scripts && typeof pkg.scripts.build === 'string')
      if (!existsSync(join(bundlePath, mainEntry))) {
        console.log(`desktop plugin build: ${bundleName} — main "${mainEntry}" missing, installing deps…`)
        const installResult = await runCommand('pnpm', ['install', '--ignore-scripts'], { cwd: bundlePath })
        if (installResult.code !== 0) {
          return { ok: false, error: `安装依赖失败：${installResult.stderr.slice(0, 300)}` }
        }
        if (hasBuild) {
          console.log(`desktop plugin build: running "pnpm run build" for ${bundleName}…`)
          const buildResult = await runCommand('pnpm', ['run', 'build'], { cwd: bundlePath })
          if (buildResult.code !== 0) {
            return { ok: false, error: `构建失败：${buildResult.stderr.slice(0, 300)}` }
          }
        }
      }

      // 4) 验证主入口文件现在存在
      if (!existsSync(join(bundlePath, mainEntry))) {
        const hint = hasBuild ? '已执行构建脚本但未生成入口文件' : '该插件没有 build 脚本且缺少预构建产物'
        return { ok: false, error: `${hint}：${mainEntry}` }
      }

      // 5) 在 profile 中安装所有依赖（解析 peer deps 等）
      await runCommand('pnpm', ['install', '--no-frozen-lockfile'], { cwd: WEB_PROFILE_DIR }).catch(() => {})

      // 6) 保存订阅记录
      const subs = readSubscriptions()
      if (subs[repoUrl] !== undefined) {
        subs[repoUrl].enabledBundle = bundleName
        writeSubscriptions(subs)
      }
      return { ok: true, bundleName }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('desktop:plugin-disable', async (_event, repoUrl: string, bundleName: string): Promise<PluginResult> => {
    try {
      const result = await runDshPlugin(['remove', bundleName])
      if (!result.ok) return { ok: false, error: result.message }
      const subs = readSubscriptions()
      if (subs[repoUrl] !== undefined) {
        subs[repoUrl].enabledBundle = null
        writeSubscriptions(subs)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('desktop:plugin-unsubscribe', async (_event, repoUrl: string): Promise<PluginResult> => {
    try {
      const subs = readSubscriptions()
      const sub = subs[repoUrl]
      if (sub === undefined) return { ok: false, error: '未找到订阅记录' }
      // Disable first if enabled.
      if (sub.enabledBundle) {
        await runDshPlugin(['remove', sub.enabledBundle])
      }
      // Delete cloned files (retry on a transient lock).
      try { await removeIfExists(sub.clonePath) } catch (error) {
        return { ok: false, error: `删除本地文件失败：${error instanceof Error ? error.message : String(error)}` }
      }
      delete subs[repoUrl]
      writeSubscriptions(subs)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

/**
 * Mirror base URL that hosts the app installers and `latest.yml`, used as the
 * generic update feed. The mirror serves the same CDN prefix as the runtime,
 * so the installer downloads at mirror speed instead of stalling on a direct
 * GitHub link. The environment variable overrides the default.
 *
 * Gitee has no `releases/latest` alias, so the desktop maintains a fixed
 * `stable` release whose assets (latest.yml + installer + blockmap) are
 * refreshed on every publish. The app points here; the same stable release
 * also serves the runtime-manifest.json + runtime zip for thin-shell builds.
 */
function appUpdateFeedUrl(): string | undefined {
  if (!app.isPackaged) return undefined
  return process.env.DSH_APP_UPDATE_URL
    ?? 'https://gitee.com/yixiao-xiao/dsh-pc-release/releases/download/stable/'
}

/**
 * Force the default session to connect DIRECTLY, bypassing any system proxy.
 *
 * The runtime/update downloads come from Gitee (a mainland-China host) which
 * is fastest when connected directly; system proxies (Clash etc.) route the
 * request through an overseas exit that Gitee's CDN rejects with HTTP 403.
 * GitHub release downloads, when still used, go through the gh-proxy mirror
 * list which is also reached directly. Setting mode 'direct' makes every
 * `net.fetch` bypass the system proxy so the domestic path always works.
 */
async function setupRuntimeDownloadProxy(): Promise<void> {
  try {
    await session.defaultSession.setProxy({ mode: 'direct' })
  } catch {
    // Non-fatal: direct mode is best-effort; without it the download may
    // still succeed if no system proxy is present.
  }
}

/**
 * Probe a download URL for its achievable speed by downloading a small
 * chunk and measuring the throughput. Returns bytes per second, or 0 when
 * the URL is unreachable or returns a non-2xx status.
 */
async function probeDownloadSpeed(fetchImpl: typeof fetch, url: string, probeBytes = 1_048_576): Promise<number> {
  const start = Date.now()
  try {
    const response = await fetchImpl(url, { redirect: 'follow' })
    if (!response.ok || response.body === null) return 0
    const reader = response.body.getReader()
    let received = 0
    while (received < probeBytes) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
    }
    reader.cancel()
    const elapsed = Date.now() - start
    return elapsed > 0 ? Math.round(received / (elapsed / 1000)) : 0
  } catch {
    return 0
  }
}

/**
 * Rank all download candidates (primary URL + mirrors) by measured speed,
 * fastest first. The caller passes the sorted list to ensureRuntime so the
 * fastest path is tried first. A probe that fails (0 B/s) lands at the end
 * as a fallback.
 */
async function rankMirrorsBySpeed(fetchImpl: typeof fetch, manifestUrl: string, mirrors: readonly string[]): Promise<string[]> {
  const candidates = [manifestUrl, ...mirrors.map(m => `${m}${manifestUrl}`)]
  const results: Array<{ url: string; speed: number }> = []
  for (const url of candidates) {
    const speed = await probeDownloadSpeed(fetchImpl, url)
    console.log(`desktop runtime download probe: ${url} → ${speed} B/s`)
    results.push({ url, speed })
  }
  results.sort((a, b) => b.speed - a.speed)
  return results.map(r => r.url)
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

  // Bypass the system proxy so the Gitee download always uses the direct
  // (fast) path. The runtime now ships from Gitee, a domestic host, so no
  // GitHub-style mirror is prepended; DSH_RUNTIME_MIRRORS still allows an
  // explicit mirror list for unusual networks. The archive is fetched from
  // manifest.url (the ZIP) directly — no candidates are passed in, so
  // ensureRuntime builds its list from the manifest's own URL.
  await setupRuntimeDownloadProxy()

  const runtimeDir = join(app.getPath('userData'), 'host')
  const mirrorPrefixes = (process.env.DSH_RUNTIME_MIRRORS ?? '')
      .split(',')
      .map(mirror => mirror.trim())
      .filter(mirror => mirror.length > 0)
  const outcome = await ensureRuntime({
    manifestUrl,
    runtimeDir,
    hostEntry: HOST_ENTRY,
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    downloadStallTimeoutMs: 60_000,
    downloadRetries: 1,
    mirrorPrefixes,
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

/** Result of a main-process plugin operation, serialized over IPC. */
type PluginResult = { ok: true } | { ok: false; error: string }
/** One installable plugin package discovered under an address. */
interface PluginCandidate { readonly name: string; readonly path: string }
/** A subscribed plugin repo (files cloned locally, activation optional). */
interface PluginSubscription {
  repoUrl: string
  repoName: string
  clonePath: string
  /** Bundle package name currently enabled in the profile, or null when disabled. */
  enabledBundle: string | null
  subscribedAt: string
}
/** One result row from the GitHub plugin search. */
interface GitHubRepo {
  id: number
  name: string
  fullName: string
  owner: string
  description: string
  stars: number
  htmlUrl: string
  cloneUrl: string
  topics: string[]
  defaultBranch: string
}

/** Local manifest of every subscribed plugin repo. */
function subscriptionsFile(): string {
  return join(PLUGIN_CLONE_DIR, 'subscriptions.json')
}
function readSubscriptions(): Record<string, PluginSubscription> {
  try {
    return JSON.parse(readFileSync(subscriptionsFile(), 'utf8')) as Record<string, PluginSubscription>
  } catch {
    return {}
  }
}
function writeSubscriptions(subs: Record<string, PluginSubscription>): void {
  mkdirSync(PLUGIN_CLONE_DIR, { recursive: true })
  writeFileSync(subscriptionsFile(), JSON.stringify(subs, null, 2))
}

/**
 * Make the official dsh-market bundle available in the web profile before
 * the Host is spawned.
 *
 * Host bundle resolution is two-anchored: the bundle MANIFEST resolves from
 * the dsh installation (`resources/host` packaged) or the profile, but its
 * patch inserts a loader entry whose bare module name (`dshmarket`) is
 * resolved from the PROFILE directory's node_modules parent walk. So the
 * package itself must be visible at `~/.dsh/profiles/web/node_modules/`:
 *
 * - Development installs it once with `dsh plugin --profile web add
 *   dshmarket` (pnpm links the package and its peers in the profile).
 * - Packaged, pnpm is unavailable, so the market is junctioned in from the
 *   bundled runtime closure. All of the market's peers live flat in the same
 *   `resources/host/node_modules` tree, so importing `@deepseek-ai/…` from
 *   the junction's realpath resolves there and never escapes the closure.
 *
 * Failure degrades rather than bricks the app: if the package cannot be made
 * visible the bundle reference is removed from the manifest, so an upgrade
 * from a broken launch never leaves an unresolvable `dshmarket` in the user's
 * profile (which is what crashes the Host with ERR_MODULE_NOT_FOUND).
 */
async function ensureOfficialMarketBundle(): Promise<void> {
  const pkgPath = join(WEB_PROFILE_DIR, 'package.json')
  const marketTarget = join(WEB_PROFILE_DIR, 'node_modules/dshmarket')
  const readManifest = (): { dsh?: { profile?: { bundles?: unknown } } } =>
    existsSync(pkgPath)
      ? JSON.parse(readFileSync(pkgPath, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
      : { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }
  const writeBundles = (bundles: string[]): void => {
    const pkg = readManifest()
    const profile = pkg.dsh?.profile ?? {}
    pkg.dsh = { ...pkg.dsh, profile: { ...profile, bundles } }
    if (pkg.dsh.profile === undefined) throw new Error('invalid web profile manifest')
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  }
  try {
    mkdirSync(WEB_PROFILE_DIR, { recursive: true })

    // Stage 1 — make the package visible to the profile's module resolution.
    let visible = existsSync(join(marketTarget, 'package.json'))
    if (!visible) {
      if (app.isPackaged) {
        // Thin shell: the runtime is downloaded into userData/host and the
        // market lives flat in its node_modules; full installers bundle it
        // under resources/host. packagedRuntimeRoot() picks whichever is real.
        const packagedRoot = packagedRuntimeRoot()
        const source = packagedRoot === undefined
          ? join(process.resourcesPath, 'host/node_modules/dshmarket')
          : join(packagedRoot, 'node_modules/dshmarket')
        if (existsSync(join(source, 'package.json'))) {
          // Junction (not copy) keeps a single on-disk closure; peers resolve
          // through the shared flat node_modules next to the source.
          mkdirSync(dirname(marketTarget), { recursive: true })
          symlinkSync(realpathSync(source), marketTarget, 'junction')
          visible = true
        }
      } else {
        // Development: official CLI path so pnpm links package + peers.
        console.log('desktop market: installing official dsh-market into the web profile…')
        const result = await runDshPlugin(['add', 'dshmarket'])
        visible = result.ok && existsSync(join(marketTarget, 'package.json'))
      }
    }
    if (!visible) {
      console.warn('desktop market: dshmarket unavailable; leaving it out of the profile this launch')
    }

    // Stage 2 — keep `dsh.profile.bundles` consistent with what is resolvable.
    const current = readManifest()
    const bundles = Array.isArray(current.dsh?.profile?.bundles)
      ? current.dsh?.profile?.bundles.filter((bundle): bundle is string => typeof bundle === 'string')
      : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    const hasMarket = bundles.includes('dshmarket')
    if (visible && !hasMarket) {
      bundles.push('dshmarket')
      writeBundles(bundles)
    } else if (!visible && hasMarket) {
      // A previous launch wrote the reference but the package is gone now;
      // drop it so the Host does not crash on an unresolvable loader entry.
      writeBundles(bundles.filter(bundle => bundle !== 'dshmarket'))
      console.warn('desktop market: removed stale dshmarket reference from the web profile')
    }
  } catch (error) {
    // Never let market setup take the whole app down. A broken reference is
    // worse than no market at all: remove it so the Host can boot.
    console.error('desktop market setup failed:', error instanceof Error ? error.message : String(error))
    try {
      if (existsSync(pkgPath)) {
        const pkg = readManifest()
        const bundles = Array.isArray(pkg.dsh?.profile?.bundles)
          ? pkg.dsh.profile.bundles.filter((bundle): bundle is string => typeof bundle === 'string' && bundle !== 'dshmarket')
          : undefined
        if (bundles !== undefined) writeBundles(bundles)
      }
    } catch {
      // The profile manifest itself may be unreadable; nothing more to do.
    }
  }
}

/**
 * Repair pnpm's placeholder-bug in every profile's pnpm-workspace.yaml.
 *
 * When an install fails, pnpm writes a LITERAL `set this to true or false`
 * into the allowBuilds entry instead of a boolean (pnpm issue #11535). The
 * market's "allow build scripts and retry" then reads a non-boolean value and
 * keeps blocking the dependency (e.g. node-pty) with ERR_PNPM_IGNORED_BUILDS
 * forever. This rewrites those placeholder lines to `true` before the market
 * mounts, so its approval actually sticks. Runs at every boot; no-op when no
 * profile has a corrupted file.
 */
function repairProfileAllowBuildsPlaceholders(): void {
  let profiles: string[] = []
  try {
    profiles = readdirSync(join(DSH_HOME, 'profiles'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return // no profiles directory yet — nothing to repair
  }
  for (const profile of profiles) {
    const yamlPath = join(DSH_HOME, 'profiles', profile, 'pnpm-workspace.yaml')
    if (!existsSync(yamlPath)) continue
    try {
      const yaml = readFileSync(yamlPath, 'utf8')
      if (!yaml.includes('set this to true or false')) continue
      // `key: set this to true or false` → `key: true`. The key may be a bare
      // package name or a git form, which itself contains colons
      // (`name@git+https://…`), so the non-greedy `.*?` anchors on the LAST
      // `: set this to true or false` and preserves everything before it.
      const repaired = yaml.replace(
        /^(\s*\S.*?:\s*)set this to true or false(\s*)$/gm,
        (_line, prefix: string, suffix: string) => `${prefix}true${suffix}`,
      )
      if (repaired !== yaml) {
        writeFileSync(yamlPath, repaired)
        console.log(`desktop pnpm workspace: repaired allowBuilds placeholder in ${profile}`)
      }
    } catch (error) {
      console.warn(`desktop pnpm workspace: failed to repair ${yamlPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * node-pty version the desktop runtime bundles (N-API prebuilds load in both
 * Electron 43 / ABI 148 and plain Node). npm's stable 1.1.0 ships Node-22
 * (ABI 127) prebuilds only, which the Host cannot open and which forces
 * `node-gyp rebuild` on machines without MSVC — the ELIFECYCLE failure users
 * hit installing terminal plugins like DSH-better-sidebar.
 */

/**
 * Ensure `entry` (an indented line) is present inside the top-level `blockKey`
 * block of a simple flat YAML document, dropping any block line matched by
 * `dropPattern` (when given) first. Appends a new block at EOF when the key is
 * absent. Returns the rebuilt line array.
 */
function ensureYamlBlockEntry(lines: string[], blockKey: string, entry: string, dropPattern?: RegExp): string[] {
  let blockIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === `${blockKey}:`) {
      blockIndex = i
      break
    }
  }
  if (blockIndex < 0) {
    // No block yet — append a fresh one at the end (drop blank tail lines).
    const tail = lines.filter(line => line.trim() !== '')
    return [...tail, '', `${blockKey}:`, entry]
  }
  let end = lines.length
  for (let i = blockIndex + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) {
      end = i // next top-level key ends the block
      break
    }
  }
  const original = lines.slice(blockIndex + 1, end)
  // Idempotence: when the entry is already present and nothing needs to be
  // dropped, leave the document byte-for-byte untouched (avoid rewriting the
  // file on every boot).
  const needsDrop = dropPattern !== undefined && original.some(line => dropPattern.test(line))
  const hasEntry = original.some(line => line.trim() === entry.trim())
  if (!needsDrop && hasEntry) return lines
  const block: string[] = []
  for (let i = blockIndex + 1; i < end; i += 1) {
    if (dropPattern !== undefined && dropPattern.test(lines[i])) continue
    block.push(lines[i])
  }
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
  if (!block.some(line => line.trim() === entry.trim())) block.push(entry)
  return [...lines.slice(0, blockIndex + 1), ...block, ...lines.slice(end)]
}

/**
 * Pin every profile's transitive `node-pty` to the runtime's N-API build by
 * pointing at a LOCAL copy of the runtime's own node-pty package.
 *
 * Why a local `file:` override rather than a bare version pin: the npm stable
 * 1.1.0 ships Node-22 (ABI 127) prebuilds only, which Electron 43 (ABI 148)
 * cannot open and which force `node-gyp rebuild` on machines without MSVC —
 * the ELIFECYCLE failure users hit installing terminal plugins. A bare pin to
 * `1.2.0-beta.15` still downloads from npm, and some mirrors/proxies strip
 * the prebuilds, so `prebuild.js` exits 1 and the install falls into
 * `node-gyp` again. Copying the runtime's complete package into
 * `profile/vendor/node-pty` and overriding to that `file:` target makes
 * installs independent of the download source and guaranteed complete.
 *
 * Idempotent: skips a profile whose vendor copy already matches the runtime
 * version, supersedes any older node-pty override/allowBuilds entry. Runs at
 * every boot, before the market mounts; no-op when no profile or runtime is
 * staged yet.
 */
function repairProfileNodePtyOverrides(): void {
  const runtimePtyDir = join(app.getPath('userData'), 'host', 'node_modules', 'node-pty')
  if (!existsSync(join(runtimePtyDir, 'package.json'))) return // runtime not staged yet
  let runtimeVersion: string | undefined
  try {
    const pkg = JSON.parse(readFileSync(join(runtimePtyDir, 'package.json'), 'utf8')) as { version?: unknown }
    runtimeVersion = typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return
  }
  if (runtimeVersion === undefined) return

  let profiles: string[] = []
  try {
    profiles = readdirSync(join(DSH_HOME, 'profiles'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return // no profiles directory yet — nothing to repair
  }
  for (const profile of profiles) {
    const profileDir = join(DSH_HOME, 'profiles', profile)
    const yamlPath = join(profileDir, 'pnpm-workspace.yaml')
    if (!existsSync(yamlPath)) continue
    // 1) Materialize the runtime's complete node-pty into profile/vendor once.
    const vendorPtyDir = join(profileDir, 'vendor', 'node-pty')
    try {
      let vendorOk = existsSync(join(vendorPtyDir, 'package.json'))
      if (vendorOk) {
        try {
          const vp = JSON.parse(readFileSync(join(vendorPtyDir, 'package.json'), 'utf8')) as { version?: unknown }
          vendorOk = vp.version === runtimeVersion
        } catch {
          vendorOk = false
        }
      }
      if (!vendorOk) {
        rmSync(vendorPtyDir, { recursive: true, force: true })
        mkdirSync(dirname(vendorPtyDir), { recursive: true })
        cpSync(runtimePtyDir, vendorPtyDir, { recursive: true, dereference: true })
        console.log(`desktop pnpm workspace: materialized node-pty ${runtimeVersion} vendor for ${profile}`)
      }
    } catch (error) {
      console.warn(`desktop pnpm workspace: failed to vendor node-pty for ${profile}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    // 2) Rewrite pnpm-workspace.yaml: override node-pty to the local vendor
    //    copy and allow its build script under the spec pnpm resolves for
    //    `file:` deps (verified: pnpm reports `node-pty@file:vendor/node-pty`).
    try {
      const yaml = readFileSync(yamlPath, 'utf8')
      const lines = yaml.split('\n')
      let repairedLines = ensureYamlBlockEntry(
        lines,
        'allowBuilds',
        `  'node-pty@file:vendor/node-pty': true`,
      )
      repairedLines = ensureYamlBlockEntry(
        repairedLines,
        'overrides',
        '  node-pty: file:./vendor/node-pty',
        /^\s+node-pty:(?!\s*file:\.\/vendor\/node-pty)/, // supersede any older node-pty pin
      )
      const repaired = repairedLines.join('\n')
      if (repaired !== yaml) {
        writeFileSync(yamlPath, repaired)
        console.log(`desktop pnpm workspace: pinned node-pty to local vendor in ${profile}`)
      }
    } catch (error) {
      console.warn(`desktop pnpm workspace: failed to pin node-pty in ${yamlPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Point each profile's `@deepseek-ai` scope at the runtime's own scope.
 *
 * Legacy/full-installer-era profiles can carry a REAL `node_modules/@deepseek-ai`
 * directory (independent copies pinned to an older version, e.g. `0.1.0-rc.8`)
 * left over from an early `pnpm install --node-linker=hoisted` bootstrap. The
 * patched runtime upgrades to a newer version (e.g. `0.1.2-alpha.1`), and while
 * bundle entries REFERENCED BY PATH that the profile copy lacks (such as
 * `@deepseek-ai/dsh-session-log-export`, injected by `dsh-web-app`'s
 * `cordis.patch.yml`) resolve up the tree into the runtime junction, their
 * inject-style peer services (`connection`, `commands`) STILL resolve into the
 * stale profile copy → their apply() sees `ctx.connection === undefined` and
 * the whole plugin tree fails to load. Fix: replace the stale real directory
 * with a junction into the runtime's scope so every `@deepseek-ai/*` user in
 * the profile resolves the same version. Idempotent (never touches junctions,
 * never touches profiles whose copy already matches the runtime). The stale
 * directory is renamed aside (not deleted) so nothing is lost.
 */
function repairProfileDeepSeekAiScopeOverlay(): void {
  const runtimeScope = runtimeDeepSeekAiScope()
  if (!existsSync(runtimeScope)) return
  let profiles: string[] = []
  try {
    profiles = readdirSync(join(DSH_HOME, 'profiles'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return
  }
  for (const profile of profiles) {
    const target = join(DSH_HOME, 'profiles', profile, 'node_modules/@deepseek-ai')
    if (!existsSync(target)) continue
    const stat = statSyncSafe(target)
    if (stat === undefined) continue
    // Junction/symlink already opens the runtime scope (or the user's own) —
    // leave it alone. A reparse-point check skips both, so this also never
    // fights what Host itself junctions in.
    if (stat.isSymbolicLink()) continue
    // A REAL directory: only replace it when it actually diverges from the
    // runtime, i.e. it carries a heartbeat package whose version differs.
    const heartbeat = 'dsh-client-connection'
    const profileVersion = readPackageVersion(join(target, heartbeat))
    const runtimeVersion = readPackageVersion(join(runtimeScope, heartbeat))
    if (profileVersion === undefined || runtimeVersion === undefined) continue
    if (profileVersion === runtimeVersion) continue // already in sync
    console.log(`desktop plugin scope: ${profile} has stale @deepseek-ai@${profileVersion} (runtime ${runtimeVersion}) — switching to junction`)
    const stale = `${target}-legacy-${profileVersion}`
    try {
      // Remove any leftover backup of the same version, then move aside & relink.
      if (existsSync(stale)) rmSync(stale, { recursive: true, force: true })
      renameSync(target, stale)
      symlinkSync(runtimeScope, target, 'junction')
      console.log(`desktop plugin scope: linked ${profile}/node_modules/@deepseek-ai -> runtime ${runtimeVersion} (old copy kept at ${stale})`)
    } catch (error) {
      // Best-effort; restore the directory if the relink failed so the profile
      // never ends up missing its scope entirely.
      if (!existsSync(target) && existsSync(stale)) renameSync(stale, target)
      console.warn(`desktop plugin scope: repair failed for ${profile}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** lstat wrapper that returns undefined instead of throwing. */
function statSyncSafe(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/** Read a package's `version` field, or undefined when absent/unreadable. */
function readPackageVersion(packageJsonPath: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** Short in-memory cache for GitHub searches (unauthenticated rate limits). */
const searchCache = new Map<string, { at: number; repos: GitHubRepo[]; totalCount?: number }>()
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000
/** Error descriptions per search key, for surfacing to the UI. */
const searchErrors = new Map<string, string>()

/** Per-request attempt timeout, short so every mirror gets a fair try. */
const GITHUB_ATTEMPT_TIMEOUT_MS = 6_000

/**
 * GitHub mirror prefixes tried after the direct URL. `DSH_GITHUB_MIRRORS`
 * (comma-separated) overrides; otherwise a set of common mainland-accessible
 * proxies that prepend to a full github.com / api.github.com URL.
 */
function githubMirrorPrefixes(): string[] {
  const fromEnv = (process.env.DSH_GITHUB_MIRRORS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  if (fromEnv.length > 0) return fromEnv
  return [
    'https://ghfast.top/',
    'https://gh-proxy.com/',
    'https://ghproxy.net/',
  ]
}

/** Candidate URLs for one original, direct first then mirrors (deduped). */
function mirrorUrlCandidates(original: string): string[] {
  const candidates = [original]
  for (const prefix of githubMirrorPrefixes()) {
    const mirrored = `${prefix}${original}`
    if (!candidates.includes(mirrored)) candidates.push(mirrored)
  }
  return candidates
}

/**
 * Fetch with a hard timeout via Promise.race — net.fetch may ignore an abort
 * signal on a stalled DNS/TCP, but the race always fires on time.
 */
async function fetchWithTimeout(url: string, timeoutMs = GITHUB_ATTEMPT_TIMEOUT_MS, init?: RequestInit): Promise<Response> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
    net.fetch(url, init).then(
      (res) => { clearTimeout(timer); resolve(res) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

/** Query GitHub's repository search for dsh plugins, sorted by stars. */
async function searchGitHubRepos(category: 'community' | 'theme', query: string, page = 1): Promise<{ repos: GitHubRepo[]; error?: string; totalCount?: number }> {
  const q = query.trim()
  // Theme category unions the theme/skin topics (deduped below); community is the umbrella topic.
  const topics = category === 'theme' ? ['dsh-theme', 'dsh-skin'] : ['dsh-plugin']
  const cacheKey = `${category}:${q}:${page}`
  const cached = searchCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return { repos: cached.repos, totalCount: cached.totalCount }

  searchErrors.clear()
  const merged = new Map<number, GitHubRepo>()
  const results = await Promise.all(topics.map(topic => fetchTopic(topic, q, page)))
  let totalCount: number | undefined
  for (const items of results) {
    for (const repo of items.repos) merged.set(repo.id, repo)
    if (totalCount === undefined && items.totalCount !== undefined) totalCount = items.totalCount
  }
  const repos = Array.from(merged.values()).sort((a, b) => b.stars - a.stars)
  searchCache.set(cacheKey, { at: Date.now(), repos, totalCount })
  // If nothing loaded and every attempt errored, surface it instead of an empty list.
  if (repos.length === 0 && searchErrors.size > 0) {
    const reasons = [...new Set(searchErrors.values())].join('；')
    return { repos: [], error: `无法访问 GitHub（${reasons}）。已尝试直连与国内镜像，请检查网络后重试。` }
  }
  return { repos, totalCount }
}

/** Race one GitHub topic search across direct + mirrors; [] if all fail. */
async function fetchTopic(topic: string, q: string, page = 1): Promise<{ repos: GitHubRepo[]; totalCount?: number }> {
  const searchQuery = `topic:${topic}${q === '' ? '' : ` ${q}`}`
  const perPage = 30
  const direct = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'deepseek-harness-desktop',
  }
  // Fire direct + every mirror in parallel; first valid response wins.
  const attempts = mirrorUrlCandidates(direct).map(async (url) => {
    const response = await fetchWithTimeout(url, GITHUB_ATTEMPT_TIMEOUT_MS, { headers })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as { items?: unknown[]; total_count?: unknown }
    const out: GitHubRepo[] = []
    for (const item of body.items ?? []) {
      const repo = item as {
        id: number; name?: unknown; full_name?: unknown; html_url?: unknown; clone_url?: unknown
        owner?: { login?: unknown } | null; description?: unknown; stargazers_count?: unknown; topics?: unknown; default_branch?: unknown
      }
      if (typeof repo.name !== 'string') continue
      out.push({
        id: repo.id,
        name: repo.name,
        fullName: typeof repo.full_name === 'string' ? repo.full_name : repo.name,
        owner: typeof repo.owner?.login === 'string' ? repo.owner.login : '',
        description: typeof repo.description === 'string' ? repo.description : '',
        stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
        htmlUrl: typeof repo.html_url === 'string' ? repo.html_url : '',
        cloneUrl: typeof repo.clone_url === 'string' ? repo.clone_url : `https://github.com/${repo.full_name ?? repo.name}.git`,
        topics: Array.isArray(repo.topics) ? repo.topics.filter((t): t is string => typeof t === 'string') : [],
        defaultBranch: typeof repo.default_branch === 'string' ? repo.default_branch : 'main',
      })
    }
    return { repos: out, totalCount: typeof body.total_count === 'number' ? body.total_count : undefined }
  })
  try {
    return await Promise.any(attempts)
  } catch (error) {
    // Every candidate failed; record a reason for the UI.
    const reasons = error instanceof AggregateError
      ? [...new Set(error.errors.map(e => e instanceof Error ? e.message : String(e)))].join('；')
      : String(error)
    searchErrors.set(`${topic}:${q}:${page}`, reasons)
    return { repos: [] }
  }
}

/**
 * Verify a GitHub repo exposes a valid `dsh.bundle.patch` in its package.json.
 * Uses the same direct + mirror strategy as the search so mainland networks pass.
 * `reachable:false` means no candidate (direct or mirror) could be fetched —
 * the caller should NOT treat that as "not a plugin", just skip the filter.
 */
async function dshBundleCheck(fullName: string, defaultBranch: string): Promise<{ reachable: boolean; verified: boolean }> {
  for (const branch of [...new Set([defaultBranch, 'main', 'master'].filter(Boolean))]) {
    const original = `https://raw.githubusercontent.com/${fullName}/${branch}/package.json`
    const attempts = mirrorUrlCandidates(original).map(async (url): Promise<boolean> => {
      const response = await fetchWithTimeout(url, GITHUB_ATTEMPT_TIMEOUT_MS)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const pkg = await response.json() as { dsh?: { bundle?: { patch?: unknown } } }
      return Boolean(pkg.dsh?.bundle?.patch)
    })
    try {
      // First candidate that resolves without throwing wins the race.
      const verdict = await Promise.any(attempts)
      return { reachable: true, verified: verdict }
    } catch {
      // This branch failed everywhere; try the next branch name.
    }
  }
  return { reachable: false, verified: false }
}

/** Fetch a GitHub repo's README via mirrors, returning Chinese and English versions. */
async function fetchRepoReadme(fullName: string, defaultBranch: string): Promise<{ zh?: string; en?: string }> {
  const branches = [...new Set([defaultBranch, 'main', 'master'].filter(Boolean))]
  const zhFiles = ['README.zh.md', 'README_zh.md', 'README_CN.md', 'readme.zh.md', 'README.zh-CN.md', 'README.zh_CN.md', 'README_中文.md']
  const enFiles = ['README.md', 'readme.md', 'README.markdown', 'Readme.md']

  async function tryReadme(files: string[]): Promise<string | undefined> {
    for (const branch of branches) {
      for (const file of files) {
        const original = `https://raw.githubusercontent.com/${fullName}/${branch}/${file}`
        const attempts = mirrorUrlCandidates(original).map(async (url) => {
          const response = await fetchWithTimeout(url, GITHUB_ATTEMPT_TIMEOUT_MS)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return await response.text()
        })
        try { return await Promise.any(attempts) } catch { /* try next */ }
      }
    }
    return undefined
  }

  const [zh, en] = await Promise.all([tryReadme(zhFiles), tryReadme(enFiles)])
  if (!zh && !en) throw new Error('README not found')
  return { zh, en }
}

/** Resolve the dsh CLI entry the desktop app uses (development checkout or packaged runtime). */
function dshCliEntry(): string {
  const upstreamRoot = join(DESKTOP_DIR, 'upstream')
  if (existsSync(upstreamRoot)) {
    const dev = join(upstreamRoot, 'apps/cli/lib/bin.js')
    if (existsSync(dev)) return dev
  }
  if (app.isPackaged) {
    // Thin shell: the runtime (and its CLI) lives in userData/host; full
    // installers bundle it under resources/host.
    const packagedRoot = packagedRuntimeRoot()
    if (packagedRoot !== undefined) {
      const entry = join(packagedRoot, HOST_ENTRY)
      if (existsSync(entry)) return entry
    }
  }
  return join(process.resourcesPath, 'host', HOST_ENTRY)
}

/** The Node executable used to run the dsh CLI in this app context. */
function dshNodeExecutable(): string {
  return app.isPackaged ? process.execPath : (process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? 'node')
}

/** Directory holding the bundled standalone pnpm executable, or undefined. */
function bundledPnpmBinDir(): string | undefined {
  const root = app.isPackaged
    ? (packagedRuntimeRoot() ?? join(process.resourcesPath, 'host'))
    : join(DESKTOP_DIR, 'runtime-host')
  const pnpmRoot = join(root, 'bin', 'pnpm')
  return existsSync(join(pnpmRoot, 'pnpm.cmd')) ? pnpmRoot : undefined
}

/**
 * Prepend the bundled pnpm bin directory to a PATH value. The plugin market
 * probes and shells out to `pnpm` for every install, and a packaged desktop
 * has neither a system pnpm nor npm/corepack to provision one — so the
 * bundled `pnpm.exe` (staged into `runtime-host/bin/pnpm`) is the one pnpm
 * the Host can always find. Development keeps its own PATH untouched (the
 * checkout machine has pnpm).
 */
function pathWithBundledPnpm(pathValue: string | undefined): string | undefined {
  const bin = bundledPnpmBinDir()
  if (bin === undefined) return pathValue
  const separator = process.platform === 'win32' ? ';' : ':'
  const parts = (pathValue ?? '').split(separator).filter(part => part !== '')
  if (!parts.includes(bin)) parts.unshift(bin)
  return parts.join(separator)
}

/**
 * Make the bundled pnpm visible to every child process (Host, `dsh plugin`,
 * plugin rebuilds, and the dsh-market's own pnpm probes): prepend its bin
 * directory to PATH and point `DSH_DESKTOP_NODE_EXECUTABLE` at the Node that
 * runs the pnpm.cmd shim.
 *
 * IMPORTANT: must be (re)called AFTER the remote runtime is downloaded. The
 * thin shell resolves the runtime into userData/host during boot, and until
 * that lands `bundledPnpmBinDir()` is undefined — so an early one-shot call
 * would leave `DSH_DESKTOP_NODE_EXECUTABLE` unset and every later
 * `pnpm.cmd --version` (the market's probe) would expand the shim's
 * `%DSH_DESKTOP_NODE_EXECUTABLE%` to nothing and fail.
 */
function ensurePnpmEnvironment(): void {
  const bundledPnpm = bundledPnpmBinDir()
  if (bundledPnpm !== undefined) {
    process.env.PATH = pathWithBundledPnpm(process.env.PATH)
  }
  // The bundled pnpm.cmd shim invokes "$DSH_DESKTOP_NODE_EXECUTABLE".
  // Packaged, that is Electron's embedded Node (this process); development
  // keeps the system node used by dshNodeExecutable(). Set unconditionally
  // (independent of pnpm presence) so the Host and every market child inherit
  // a resolvable shim executable even on the very first thin-shell launch.
  if (process.env.DSH_DESKTOP_NODE_EXECUTABLE === undefined) {
    process.env.DSH_DESKTOP_NODE_EXECUTABLE = app.isPackaged ? process.execPath : 'node'
  }
}

/** Run one command, resolving with its exit code and captured output. */
function runCommand(executable: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      executable,
      args,
      {
        cwd: options?.cwd,
        env: options?.env === undefined ? undefined : { ...process.env, ...options.env },
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error === null ? 0 : Number(error.code ?? '1'),
          stdout,
          stderr,
        })
      },
    )
  })
}

/** Run `dsh plugin ...` against the web profile through the app's own CLI. */
async function runDshPlugin(pnpmArgs: string[]): Promise<{ ok: boolean; message: string }> {
  const env = app.isPackaged ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
  const result = await runCommand(dshNodeExecutable(), ['--expose-internals', dshCliEntry(), 'plugin', '--profile', 'web', ...pnpmArgs], {
    cwd: WEB_PROFILE_DIR,
    env,
  })
  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (result.code !== 0) return { ok: false, message: output || `dsh plugin 退出码 ${result.code}` }
  return { ok: true, message: output }
}

/**
 * Directory of the packaged Host runtime: the full installer bundles it
 * under resources/host, while the thin shell downloads it into the per-user
 * data dir (userData/host). Both trees share the same layout (bin/pnpm,
 * node_modules/dshmarket, node_modules/@deepseek-ai). Returns null when no
 * packaged runtime is present.
 */
function packagedRuntimeRoot(): string | undefined {
  const candidates = [
    // Thin shell: remote runtime installed into the user data directory. This
    // is the published, patched runtime (native picker, brand, opener), and
    // it is what resolveHostPaths() selected, so it takes precedence.
    join(app.getPath('userData'), 'host'),
    // Full/offline installer: runtime copied into resources/host at pack time.
    join(process.resourcesPath, 'host'),
  ]
  return candidates.find(root => existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
}

/** Dir holding the runtime's shared `@deepseek-ai/*` packages (used as plugin peer deps). */
function runtimeDeepSeekAiScope(): string {
  if (app.isPackaged) {
    const packagedRoot = packagedRuntimeRoot()
    if (packagedRoot !== undefined) {
      const scoped = join(packagedRoot, 'node_modules/@deepseek-ai')
      if (existsSync(scoped)) return scoped
    }
    // Fall back to the legacy in-installer layout for old full packages.
    const legacy = join(process.resourcesPath, 'host/node_modules/@deepseek-ai')
    if (existsSync(legacy)) return legacy
  }
  return [
    join(DESKTOP_DIR, 'upstream/apps/cli/node_modules/@deepseek-ai'),
    join(DESKTOP_DIR, 'upstream/node_modules/@deepseek-ai'),
  ].find(p => existsSync(p)) ?? join(DESKTOP_DIR, 'upstream/node_modules/@deepseek-ai')
}

/**
 * Junction the runtime's `@deepseek-ai/*` packages into `~/.dsh/node_modules/@deepseek-ai`
 * so third-party plugins (cloned into ~/.dsh/plugins) can resolve their peer deps
 * (`@deepseek-ai/dsh-session` etc.) by walking up the node_modules tree — exactly how
 * the Host CLI itself resolves its workspace packages. Idempotent: existing junctions
 * are left untouched.
 */
function ensurePluginRuntimeLinks(): void {
  const scope = runtimeDeepSeekAiScope()
  if (!existsSync(scope)) return
  const target = join(DSH_HOME, 'node_modules/@deepseek-ai')
  try {
    mkdirSync(join(DSH_HOME, 'node_modules'), { recursive: true })
    mkdirSync(target, { recursive: true })
    let created = 0
    for (const entry of readdirSync(scope, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const src = join(scope, entry.name)
      const dst = join(target, entry.name)
      if (existsSync(dst)) continue
      try {
        symlinkSync(realpathSync(src), dst, 'junction')
        created++
      } catch (error) {
        console.warn(`desktop plugin runtime link: failed ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (created > 0) console.log(`desktop plugin runtime link: linked ${created} @deepseek-ai package(s) into ${target}`)
  } catch (error) {
    console.warn(`desktop plugin runtime link: setup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Rebuild subscribed plugins whose main entry file is missing (e.g. they were
 * enabled before the auto-build step existed, so `lib/index.js` was never
 * emitted). Reads the profile's `link:` dependencies to locate each plugin
 * clone and runs its install + build scripts. Best-effort; failures are logged
 * but never block startup.
 */
async function rebuildMissingPluginEntries(): Promise<void> {
  try {
    const pkgPath = join(WEB_PROFILE_DIR, 'package.json')
    if (!existsSync(pkgPath)) return
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> }
    const deps = pkg.dependencies ?? {}
    for (const [name, spec] of Object.entries(deps)) {
      // 内置 @deepseek-ai 包跳过；只处理 link: 到本地插件的依赖
      if (name.startsWith('@deepseek-ai/')) continue
      const linkSpec = /^link:(.+)/i.exec(spec.trim())
      if (!linkSpec) continue
      const pluginDir = linkSpec[1].replace(/[\/\\]+$/g, '')
      const pluginPkgPath = join(pluginDir, 'package.json')
      if (!existsSync(pluginPkgPath)) continue
      let mainEntry = 'lib/index.js'
      let hasBuild = false
      try {
        const pp = JSON.parse(readFileSync(pluginPkgPath, 'utf8')) as { main?: unknown; scripts?: { build?: unknown } }
        if (typeof pp.main === 'string' && pp.main !== '') mainEntry = pp.main
        hasBuild = !!pp.scripts && typeof pp.scripts.build === 'string'
      } catch { /* ignore */ }
      if (existsSync(join(pluginDir, mainEntry))) continue // 主入口已存在，跳过

      console.log(`desktop plugin rebuild: ${name} — main "${mainEntry}" missing, building…`)
      await runCommand('pnpm', ['install', '--ignore-scripts'], { cwd: pluginDir }).catch(() => {})
      if (hasBuild) {
        await runCommand('pnpm', ['run', 'build'], { cwd: pluginDir }).catch((error: unknown) => {
          console.warn(`desktop plugin rebuild: ${name} build failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
    }
  } catch (error) {
    console.warn(`desktop plugin rebuild: scan failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Derive a safe local folder name from a git clone URL. */
function repoFolderName(url: string): string {
  const cleaned = url.replace(/^https?:\/\//i, '').replace(/[\/]+$/g, '')
  const parts = cleaned.split('/').filter(part => part.length > 0)
  const tail = parts.at(-1) ?? 'repo'
  const folder = tail.replace(/\.git$/i, '').replace(/[^\w.-]/g, '-')
  return folder === '' ? 'repo' : folder
}

/** Scan a directory tree (root + direct children) for plugin packages. */
function scanForPluginCandidates(root: string): PluginCandidate[] {
  const candidates: PluginCandidate[] = []
  const seen = new Set<string>()
  const dirs = [root]
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(root, entry.name))
    }
  } catch {
    // Unreadable root; fall through with just the root.
  }
  for (const dir of dirs) {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; dsh?: unknown }
      // A plugin bundle/patch declares a `dsh` key; ignore bare packages.
      if (pkg.dsh === undefined) continue
      const name = typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : basename(dir)
      const key = join(dir, name)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ name, path: dir })
    } catch {
      // Malformed package.json; not a candidate.
    }
  }
  return candidates
}

/** Wait helper for lock/scan retries. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Remove a path with retries. On Windows, if a persistent lock prevents
 *  recursive delete, rename the tree (atomic, non-recursive → bypasses deep
 *  locks) and schedule a detached rmdir so the cleanup does not block us. */
async function removeIfExists(path: string): Promise<void> {
  if (!existsSync(path)) return
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch {
      if (attempt < 2) await sleep(500)
    }
  }
  // Last resort: atomic rename then detached cleanup.
  const backup = `${path}.del-${Date.now()}`
  try { rmSync(backup, { recursive: true, force: true }) } catch { /* ignore */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(path, backup)
      break
    } catch (error) {
      if (attempt >= 2) throw error instanceof Error ? error : new Error(String(error))
      await sleep(400)
    }
  }
  if (process.platform === 'win32') {
    // Detached cmd so the app does not wait for the recursive deletion.
    const child = spawn('cmd', ['/c', 'rmdir', '/s', '/q', backup], {
      detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()
  } else {
    try { rmSync(backup, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

/** Clone a Git URL into the plugin staging area, trying direct then mirrors. */
async function cloneRepo(url: string): Promise<PluginResult & { path?: string }> {
  mkdirSync(PLUGIN_CLONE_DIR, { recursive: true })
  const dest = join(PLUGIN_CLONE_DIR, repoFolderName(url))
  // Only mirror github.com clones; other hosts (gitlab, gitee, local) go direct.
  const candidates = /github\.com/iu.test(url) ? mirrorUrlCandidates(url) : [url]
  let lastError = ''
  for (const candidate of candidates) {
    try {
      // Clear a stale/locked clone before cloning (retries on transient locks).
      await removeIfExists(dest)
      const clone = await runCommand('git', ['clone', '--depth', '1', candidate, dest])
      if (clone.code === 0) return { ok: true, path: dest }
      lastError = clone.stderr.trim() || clone.stdout.trim() || `git clone 退出码 ${clone.code}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, error: lastError || 'git clone 失败' }
}

/** Resolve an install address into candidate plugin packages. */
async function resolvePluginAddress(address: string): Promise<(PluginResult & { candidates?: PluginCandidate[] })> {
  const trimmed = address.trim()
  if (trimmed === '') return { ok: false, error: '地址为空' }
  // Local path?
  if (existsSync(trimmed)) {
    return { ok: true, candidates: scanForPluginCandidates(trimmed) }
  }
  // HTTP(S) Git URL?
if (/^https?:\/\//iu.test(trimmed)) {
    const cloned = await cloneRepo(trimmed)
    if (!cloned.ok) return { ok: false, error: cloned.error }
    return { ok: true, candidates: scanForPluginCandidates(cloned.path!) }
  }
  return { ok: false, error: '地址无效：既不是本地目录，也不是 HTTP(s) 仓库地址' }
}

/** Open (or focus) the plugin manager dialog window. */
function openPluginManager(): void {
  let manager = managerWindow
  if (manager !== undefined && !manager.isDestroyed()) {
    manager.focus()
    return
  }
  manager = new BrowserWindow({
    width: 780,
    height: 780,
    minWidth: 580,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: '插件管理',
    parent: mainWindow,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: pluginManagerPreloadPath(),
    },
  })
  managerWindow = manager
  manager.on('closed', () => {
    if (managerWindow === manager) managerWindow = undefined
  })
  void manager.loadFile(pluginManagerHtmlPath(), {
    search: `?theme=${nativeTheme.themeSource}`,
  }).then(() => {
    if (!manager.isDestroyed()) manager.show()
  })
}

async function createMainWindow(): Promise<BrowserWindow> {
  const hostUrl = hostOrigin
  if (hostUrl === undefined) throw new Error('desktop Host is not ready')
  // The readiness URL may carry the host's per-boot auth token in its query
  // (newer `dsh web` hosts reject the page without it), so the window loads
  // the FULL URL, while navigation allow-list checks still compare bare origins.
  const origin = new URL(hostUrl).origin
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
  // The loaded dsh web page sets its own <title> (which leaks build labels
  // like "… build …"); lock the window title to the product name so no
  // internal build string shows in the title bar or task switcher.
  // The title is hard-coded to APP_NAME on every possible path: window
  // creation, each page-title update, and after every navigation event, so
  // it can never drift to anything else.
  const lockWindowTitle = (): void => {
    if (!window.isDestroyed()) window.setTitle(APP_NAME)
  }
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    lockWindowTitle()
  })
  window.webContents.on('did-navigate', lockWindowTitle)
  window.webContents.on('did-navigate-in-page', lockWindowTitle)
  window.webContents.on('did-finish-load', lockWindowTitle)
  lockWindowTitle()
  window.webContents.on('will-navigate', (event, url) => {
    if (hasOrigin(url, origin)) return
    event.preventDefault()
    if (isExternalUrl(url)) void shell.openExternal(url)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Re-inject desktop features on every page load (Ctrl+R / F5). The injection
  // is idempotent (checks for existing elements), so running it on every
  // main-frame load — including the initial one — is safe.
  window.webContents.on('did-finish-load', () => {
    window.webContents.executeJavaScript(`(() => {
      const api = window.desktop
      if (typeof api === 'undefined') return

      /* ── theme sync ── */
      const syncTheme = () => {
        const isDark = document.body?.getAttribute('data-ds-dark-theme') === ''
        api.setNativeTheme(isDark ? 'dark' : 'light')
      }
      syncTheme()
      new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

      // Override the "打开配置文件" button to call the main-process opener
      // (bypasses the Host API entirely, avoiding the hidden window-station issue).
      const overrideOpenDoc = () => {
        const buttons = document.querySelectorAll('button')
        for (const button of buttons) {
          if (button.textContent?.trim() === '打开配置文件' && !button.getAttribute('data-dsh-overridden')) {
            button.setAttribute('data-dsh-overridden', 'true')
            button.addEventListener('click', (e) => {
              e.stopPropagation()
              e.preventDefault()
              window.desktop?.openDocument()
            }, true)
          }
        }
      }
      overrideOpenDoc()
      // Keep the configuration-file override alive across React re-renders.
      new MutationObserver(overrideOpenDoc).observe(document.body, { childList: true, subtree: true })

      /* ── sidebar brand title lock ── */
      // The web UI shows a local-build brand label ("DSH 本地构建" /
      // "DSH Local Build"). Hard-code the sidebar brand title to the product
      // name here (shell-side injection, NOT an upstream edit) so it stays
      // identical.
      // TEXT-ONLY: rewrite the label's text node value directly. We never
      // touch DOM structure, classes, fonts, colors or layout — a naive
      // textContent assignment would destroy child nodes and visually change
      // the label, which is exactly what must be avoided.
      const FIXED_BRAND_TITLE = 'DeepSeek Harness'
      const BRAND_LABELS = new Set(['DSH 本地构建', 'DSH Local Build'])
      const fixSidebarBrand = () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        // NOTE: injected JS runs as plain script in the renderer — no TS type
        // annotations here or the whole block throws a SyntaxError.
        let textNode
        while ((textNode = walker.nextNode()) !== null) {
          const raw = textNode.nodeValue ?? ''
          if (!BRAND_LABELS.has(raw.trim())) continue
          textNode.nodeValue = raw.replace(raw.trim(), FIXED_BRAND_TITLE)
        }
        // Also pin the page title text (tabs/Alt+Tab), again text-only.
        if (document.title.includes('DSH') || document.title.includes('本地构建')) {
          document.title = FIXED_BRAND_TITLE
        }
      }
      fixSidebarBrand()
      new MutationObserver(fixSidebarBrand).observe(document.body, { childList: true, subtree: true, characterData: true })
    })()`, true).catch(() => {})
  })
  await window.loadURL(hostUrl)
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
  // Bypass any system proxy for every app-initiated fetch (plugin market
  // GitHub mirrors, the Gitee runtime/update downloads). Gitee is a domestic
  // host — direct is fastest; system proxies (Clash etc.) route through an
  // overseas exit that Gitee rejects with HTTP 403.
  void setupRuntimeDownloadProxy()
  // Make the bundled standalone pnpm visible to every child the main process
  // spawns (Host, `dsh plugin`, plugin rebuilds). On the very first
  // thin-shell launch the runtime is not downloaded yet, so DSH_DESKTOP_NODE_EXECUTABLE
  // is set here unconditionally; PATH prepend is re-done after the runtime
  // lands (see resolveHostPaths caller below). No-op when the runtime was not
  // staged with pnpm.
  ensurePnpmEnvironment()
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
  // Start a poller that opens files the Host (ELECTRON_RUN_AS_NODE child)
  // writes to a temp file.  The Host's children cannot spawn visible GUI
  // windows (hidden window station issue), so the main process does it.
  const OPEN_DOC_TMP = join(process.env.TEMP ?? process.env.TMP ?? '', 'dsh-open-doc.txt')
  const openDocTimer = setInterval(() => {
    try {
      const p = readFileSync(OPEN_DOC_TMP, 'utf8').trim()
      if (p.length > 0) {
        writeFileSync(OPEN_DOC_TMP, '')
        // shell.openPath returns '' on success, error string on failure.
        // For unassociated file types (.yaml/.yml/.json) it returns an error
        // and does nothing — fall back to rundll32 OpenAs_RunDLL which shows
        // the "Open With" dialog.  From the main process (interactive session)
        // the dialog is visible on the user's desktop.
        void shell.openPath(p).then((error) => {
          if (error !== '') {
            execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', p], { windowsHide: true })
          }
        })
      }
    } catch { /* file missing or empty — nothing to open */ }
  }, 800)

  // Directory-picker bridge for the packaged Host. The Host's native Win32
  // picker drives its dialog through koffi (FFI), which crashes under
  // Electron-as-node (NAPI ABI mismatch), so a patched worker instead writes a
  // request file; the main process answers with the real native folder dialog
  // (dialog.showOpenDialog) and writes the chosen path back. Same bridge
  // pattern as the file-opener above — the Host child cannot show GUI windows.
  const PICK_DIR_TMP = join(process.env.TEMP ?? process.env.TMP ?? '', 'dsh-pick-dir.txt')
  const PICK_DIR_RESULT_TMP = join(process.env.TEMP ?? process.env.TMP ?? '', 'dsh-pick-dir-result.txt')
  const pickDirTimer = setInterval(() => {
    try {
      const title = readFileSync(PICK_DIR_TMP, 'utf8').trim()
      if (title.length === 0) return
      // Clear the request immediately so a slow dialog never re-fires; the
      // worker polls the result file for the answer.
      writeFileSync(PICK_DIR_TMP, '')
      void dialog
        .showOpenDialog({ title, properties: ['openDirectory'] })
        .then(({ canceled, filePaths }) => {
          const chosen = canceled || filePaths.length === 0 ? '__CANCELLED__' : filePaths[0]
          writeFileSync(PICK_DIR_RESULT_TMP, chosen, 'utf8')
        })
        .catch(() => {
          writeFileSync(PICK_DIR_RESULT_TMP, '__CANCELLED__', 'utf8')
        })
    } catch { /* file missing or empty — nothing to pick */ }
  }, 500)
  // Serial update sequence: decide the app update first, then the runtime.
  // Accepting or declining the app update skips the runtime check this launch
  // — an accepted install relaunches the app, and that relaunch (now up to
  // date) runs the runtime check. Only when no app update exists does the
  // runtime check run now. Declining therefore updates nothing at all.
  // Main-process "open document" for the settings page.  The renderer's
  // override of "打开配置文件" calls this via the desktop bridge; it resolves
  // the DSH settings document path and opens it (or shows Open With for
  // unassociated types).  Bypasses the Host API entirely, so the hidden
  // window-station issue cannot interfere.
  ipcMain.handle('desktop:open-document', async () => {
    const candidate = join(DSH_HOME, 'settings.yaml')
    if (existsSync(candidate)) {
      const error = await shell.openPath(candidate)
      if (error !== '') {
        execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', candidate], { windowsHide: true })
      }
    }
  })
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
    // The thin-shell runtime is now installed under userData/host, so the
    // bundled pnpm (inside that runtime) exists — wire PATH and re-assert
    // DSH_DESKTOP_NODE_EXECUTABLE for every downstream child (Host, market).
    ensurePnpmEnvironment()
    // Repair any pnpm "set this to true or false" placeholder that a failed
    // install wrote into a profile's allowBuilds block — otherwise the
    // market's "allow build scripts and retry" never sticks and every install
    // of a native-build plugin (node-pty etc.) is blocked forever.
    repairProfileAllowBuildsPlaceholders()
    // Pin each profile's transitive node-pty to the runtime's N-API build so
    // terminal plugins install without MSVC and load in Electron 43 (npm
    // stable 1.1.0 is Node-22-ABI only and breaks both of those).
    repairProfileNodePtyOverrides()
    // 将官方插件市场 bundle 写入 web profile（开发模式经官方 dsh plugin 安装，
    // 打包模式从内置运行时的依赖闭包解析），使设置页出现「Plugin Market」，
    // 替代旧的 GitHub 搜索/clone 链路。
    await ensureOfficialMarketBundle()
    // 启动时确保已启用插件能解析运行时 peer 依赖
    ensurePluginRuntimeLinks()
    // 修复历史遗留的 profile 旧版 @deepseek-ai 覆盖目录（早期 hoisted 安装残留），
    // 换成指向运行时 scope 的 junction，避免 bundle 插件拿到错配的服务版本而崩
    repairProfileDeepSeekAiScopeOverlay()
    // 重建主入口文件缺失的插件（如之前启用但未构建的）
    await rebuildMissingPluginEntries()
    host = createHostSupervisor({
      spawnHost: () => spawnDshWeb({
        ...paths,
        noOpenBrowser: process.env.DSH_OPEN_BROWSER !== '1',
        env: {
          ...process.env,
          DSH_DESKTOP: '1',
          // The Host runs under ELECTRON_RUN_AS_NODE, where the native Win32
          // picker's koffi FFI crashes (NAPI ABI mismatch). A patched worker
          // sees this flag and routes the folder pick through the main
          // process's dialog.showOpenDialog (the real native dialog) via a
          // temp-file request/result bridge.
          ...(app.isPackaged ? { DSH_DESKTOP_BRIDGE_PICKER: '1' } : {}),
          // Explicitly handed to the Host (not only inherited from process.env)
          // so the bundled pnpm.cmd shim always has a resolvable executable,
          // even on the very first thin-shell launch.
          DSH_DESKTOP_NODE_EXECUTABLE: app.isPackaged ? process.execPath : 'node',
          // Explicitly set DSH_FORCE_DIRECTORY_PICKER=browse only to opt back
          // into the simplified non-native backend (troubleshooting knob).
          ...(process.env.DSH_FORCE_DIRECTORY_PICKER !== undefined
            ? { DSH_FORCE_DIRECTORY_PICKER: process.env.DSH_FORCE_DIRECTORY_PICKER }
            : {}),
          // The packaged environment has no `git`, so pnpm cannot resolve
          // `github:owner/repo` plugin targets itself. The market's accelerator
          // resolves HEAD over HTTP, and this mirror gives it a reliable route
          // (same style as the runtime-download mirrors, no trailing slash).
          ...(app.isPackaged
            ? { DSHM_GITHUB_PROXY: process.env.DSHM_GITHUB_PROXY ?? 'https://gh-proxy.com' }
            : {}),
          PATH: pathWithBundledPnpm(process.env.PATH),
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
      // Defer start so the NSIS "run after install" finish action does not
      // immediately kill the freshly launched app (the installer process may
      // still be alive briefly after the finish page is dismissed).
      setTimeout(() => { installerWatch?.start() }, 20_000)
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
  const mirrors = (process.env.DSH_RUNTIME_MIRRORS ?? '')
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
