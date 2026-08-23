/** Electron application shell for the loopback DeepSeek Harness Web Host. */

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
  ipcMain.handle('desktop:plugin-search', async (_event, category: string, query: string): Promise<{ ok: true; repos: GitHubRepo[] } | { ok: false; error: string }> => {
    if (category !== 'community' && category !== 'theme') return { ok: false, error: 'category 必须是 community 或 theme' }
    try {
      const result = await searchGitHubRepos(category, query)
      if (result.error !== undefined && result.repos.length === 0) return { ok: false, error: result.error }
      return { ok: true, repos: result.repos }
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
      const result = await runDshPlugin(['add', bundlePath])
      if (!result.ok) return { ok: false, error: result.message }
      // Read the bundle name from package.json.
      let bundleName = ''
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown }
        bundleName = typeof pkg.name === 'string' ? pkg.name : ''
      } catch { /* ignore */ }
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
 */
function appUpdateFeedUrl(): string | undefined {
  if (!app.isPackaged) return undefined
  return process.env.DSH_APP_UPDATE_URL ?? 'https://gh-proxy.com/https://github.com/yxx-jf/deepseek-harness-desktop/releases/download/v0.1.0-rc.12/'
}

/**
 * Set proxy bypass rules on the default session so the runtime download
 * uses the default `net.fetch` (no custom stream conversion). System proxies
 * on Windows often return HTTP 502 for GitHub release downloads, making
 * every candidate fail. Bypassing the proxy for GitHub hosts lets the
 * download go through the direct (fast) path.
 */
async function setupRuntimeDownloadProxy(): Promise<void> {
  try {
    await session.defaultSession.setProxy({
      proxyBypassRules: 'github.com,*.github.com,*.githubusercontent.com,gh-proxy.com',
    })
  } catch {
    // Non-fatal: proxy bypass is best-effort; without it the download may
    // still succeed through a mirror that works with the system proxy.
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

  // Bypass the system proxy for GitHub hosts — many proxies return 502 for
  // release downloads, which kills every candidate before the mirror is tried.
  await setupRuntimeDownloadProxy()

  const runtimeDir = join(app.getPath('userData'), 'host')
  const mirrorPrefixes = (process.env.DSH_RUNTIME_MIRRORS ?? 'https://gh-proxy.com/')
      .split(',')
      .map(mirror => mirror.trim())
      .filter(mirror => mirror.length > 0)
  const candidates = await rankMirrorsBySpeed((input, init) => net.fetch(input instanceof URL ? input.href : input, init), manifestUrl, mirrorPrefixes)
  const outcome = await ensureRuntime({
    manifestUrl,
    runtimeDir,
    hostEntry: HOST_ENTRY,
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    downloadStallTimeoutMs: 60_000,
    downloadRetries: 1,
    candidates,
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

/** Short in-memory cache for GitHub searches (unauthenticated rate limits). */
const searchCache = new Map<string, { at: number; repos: GitHubRepo[] }>()
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
async function searchGitHubRepos(category: 'community' | 'theme', query: string): Promise<{ repos: GitHubRepo[]; error?: string }> {
  const q = query.trim()
  // Theme category unions the theme/skin topics (deduped below); community is the umbrella topic.
  const topics = category === 'theme' ? ['dsh-theme', 'dsh-skin'] : ['dsh-plugin']
  const cacheKey = `${category}:${q}`
  const cached = searchCache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < SEARCH_CACHE_TTL_MS) return { repos: cached.repos }

  searchErrors.clear()
  const merged = new Map<number, GitHubRepo>()
  const results = await Promise.all(topics.map(topic => fetchTopic(topic, q)))
  for (const items of results) {
    for (const repo of items) merged.set(repo.id, repo)
  }
  const repos = Array.from(merged.values()).sort((a, b) => b.stars - a.stars)
  searchCache.set(cacheKey, { at: Date.now(), repos })
  // If nothing loaded and every attempt errored, surface it instead of an empty list.
  if (repos.length === 0 && searchErrors.size > 0) {
    const reasons = [...new Set(searchErrors.values())].join('；')
    return { repos: [], error: `无法访问 GitHub（${reasons}）。已尝试直连与国内镜像，请检查网络后重试。` }
  }
  return { repos }
}

/** Race one GitHub topic search across direct + mirrors; [] if all fail. */
async function fetchTopic(topic: string, q: string): Promise<GitHubRepo[]> {
  const searchQuery = `topic:${topic}${q === '' ? '' : ` ${q}`}`
  const direct = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=stars&order=desc&per_page=30`
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'deepseek-harness-desktop',
  }
  // Fire direct + every mirror in parallel; first valid response wins.
  const attempts = mirrorUrlCandidates(direct).map(async (url) => {
    const response = await fetchWithTimeout(url, GITHUB_ATTEMPT_TIMEOUT_MS, { headers })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as { items?: unknown[] }
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
    return out
  })
  try {
    return await Promise.any(attempts)
  } catch (error) {
    // Every candidate failed; record a reason for the UI.
    const reasons = error instanceof AggregateError
      ? [...new Set(error.errors.map(e => e instanceof Error ? e.message : String(e)))].join('；')
      : String(error)
    searchErrors.set(`${topic}:${q}`, reasons)
    return []
  }
}

/** Resolve the dsh CLI entry the desktop app uses (development checkout or packaged runtime). */
function dshCliEntry(): string {
  const upstreamRoot = join(DESKTOP_DIR, 'upstream')
  if (existsSync(upstreamRoot)) {
    const dev = join(upstreamRoot, 'apps/cli/lib/bin.js')
    if (existsSync(dev)) return dev
  }
  return join(process.resourcesPath, 'host', HOST_ENTRY)
}

/** The Node executable used to run the dsh CLI in this app context. */
function dshNodeExecutable(): string {
  return app.isPackaged ? process.execPath : (process.env.DSH_DESKTOP_NODE_EXECUTABLE ?? 'node')
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
  // The loaded dsh web page sets its own <title> (which leaks build labels
  // like "… build …"); lock the window title to the product name so no
  // internal build string shows in the title bar or task switcher.
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(APP_NAME)
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

      /* ── inject plugin manager button into the settings dialog ── */
      const PLUGIN_BTN_ID = 'dsh-plugin-mgr-btn'
      const injectBtn = () => {
        if (document.getElementById(PLUGIN_BTN_ID) !== null) return
        // The settings panel is the full-viewport modal dialog.
        const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
        if (dialog === null) return
        // dialog → [nav, content]; content → [header, options]; header → [actions, close]
        const content = dialog.children[1]
        if (content === undefined) return
        const header = content.children[0]
        if (header === undefined) return
        const actions = header.children[0]
        if (actions === undefined) return
        const btn = document.createElement('button')
        btn.id = PLUGIN_BTN_ID
        btn.setAttribute('type', 'button')
        btn.setAttribute('aria-label', '插件管理')
        btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:none;border-radius:10px;background:rgba(255,255,255,0.06);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:30px;cursor:pointer;white-space:nowrap'
      btn.innerHTML = '⚙ 插件管理'
        btn.addEventListener('click', () => { api.openPluginManager() })
        btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--dsw-alias-interactive-bg-hover)' })
        btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,0.06)' })
        actions.appendChild(btn)
      }
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
      // Keep re-injecting whenever the DOM changes (dialog opens/closes, React re-renders).
      injectBtn()
      new MutationObserver(injectBtn).observe(document.body, { childList: true, subtree: true })
      new MutationObserver(overrideOpenDoc).observe(document.body, { childList: true, subtree: true })
    })()`, true).catch(() => {})
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
    { label: '插件管理…', click: () => { openPluginManager() } },
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
    host = createHostSupervisor({
      spawnHost: () => spawnDshWeb({
        ...paths,
        noOpenBrowser: process.env.DSH_OPEN_BROWSER !== '1',
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
  const mirrors = (process.env.DSH_RUNTIME_MIRRORS ?? 'https://gh-proxy.com/')
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
