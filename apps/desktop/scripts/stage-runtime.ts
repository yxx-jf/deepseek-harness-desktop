/** Materialize the packaged desktop Host dependency closure. */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { globSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_EXCLUDED_PACKAGES } from './runtime-excludes.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(desktopRoot, '../..')
const staging = join(desktopRoot, 'runtime-host')
const deployRoot = resolve(desktopRoot, 'runtime')
const deployPackage = '@deepseek-ai/dsh-desktop-runtime'
const entry = join(staging, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const frontend = join(staging, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html')
const workspaceState = join(repositoryRoot, 'node_modules/.pnpm-workspace-state-v1.json')
const modulesYaml = join(repositoryRoot, 'node_modules/.modules.yaml')
const fingerprintFile = join(staging, '.stage-fingerprint.json')

/** Bump when the staging procedure changes so stale trees are rebuilt. */
const STAGE_CACHE_VERSION = 3

/** Every workspace package.json glob the runtime manifest derives its closure from. */
const workspaceManifestGlobs = [
  'packages/*/*/package.json',
  'apps/*/package.json',
  'vendor/*/package.json',
  'native/landlock-run/packages/*/package.json',
]

interface StageFingerprint {
  readonly version: number
  readonly hash: string
}

interface Manifest {
  readonly dependencies?: Readonly<Record<string, string>>
}

/** Quote one command-line argument when it needs it. */
function quoteArg(argument: string): string {
  return /[ \t"]/u.test(argument) ? `"${argument.replace(/"/gu, '\\"')}"` : argument
}

async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const env = { ...process.env, CI: 'true' }
    const cwd = repositoryRoot
    // A .cmd shim cannot be spawned directly on Windows; drive the whole
    // quoted command line through the shell (the npm/cross-spawn pattern).
    const child = process.platform === 'win32' && /\.cmd$/iu.test(command)
      ? spawn([command, ...args].map(quoteArg).join(' '), { shell: true, cwd, env, stdio: 'inherit' })
      : spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept()
      else reject(new Error(
        `desktop runtime staging failed (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}): ${command} ${args.join(' ')}`,
      ))
    })
  })
}

async function manifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, 'utf8')) as Manifest
}

async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Replace every staged workspace-package symlink with its real bytes. */
async function materializeLinks(): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  for (let link = await findSymlink(nodeModules); link !== undefined; link = await findSymlink(nodeModules)) {
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const bin = segments.lastIndexOf('.bin')
    if (bin >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, bin + 1)), { recursive: true, force: true })
      continue
    }
    const source = await realpath(link)
    await rm(link, { recursive: true, force: true })
    await cp(source, link, {
      recursive: true,
      dereference: true,
      filter: path => path !== join(source, 'node_modules') && !path.startsWith(join(source, 'node_modules') + sep),
    })
  }
}

/** Restore peer-specialized workspace packages the legacy hoister placed beside the source manifest. */
async function restoreLegacyHoists(): Promise<void> {
  const deployed = await manifest(join(staging, 'package.json'))
  const sourceModules = join(deployRoot, 'node_modules')
  for (const dependency of Object.keys(deployed.dependencies ?? {})) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceModules, dependency)
    if (!existsSync(source)) throw new Error(`desktop runtime dependency is missing after deploy: ${dependency}`)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== join(source, 'node_modules') && !path.startsWith(join(source, 'node_modules') + sep),
    })
  }
}

async function deploy(): Promise<void> {
  // The deploy runs with `--config.node-linker=hoisted`, which rewrites the
  // workspace's own node_modules metadata; preserve both files so the next
  // pnpm command does not demand a from-scratch reinstall.
  const savedWorkspaceState = existsSync(workspaceState) ? await readFile(workspaceState) : undefined
  const savedModulesYaml = existsSync(modulesYaml) ? await readFile(modulesYaml) : undefined
  try {
    await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
      '--config.verify-deps-before-run=false', '--filter', deployPackage, 'deploy', '--legacy', '--prod',
      '--config.node-linker=hoisted', '--config.auto-install-peers=false', '--config.link-workspace-packages=true', staging,
    ])
  } finally {
    if (savedWorkspaceState === undefined) await rm(workspaceState, { force: true })
    else await writeFile(workspaceState, savedWorkspaceState)
    if (savedModulesYaml === undefined) await rm(modulesYaml, { force: true })
    else await writeFile(modulesYaml, savedModulesYaml)
    // The hoisted deploy rewrites the workspace node_modules to a flat layout,
    // dropping per-package node_modules, so the next full workspace build
    // cannot resolve package-local devDependencies. Re-link it after restoring
    // the metadata; best-effort so a deploy failure is not masked.
    try {
      await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install'])
    } catch (error) {
      console.warn(`desktop runtime staging: workspace re-link failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Assert every bare @deepseek-ai plugin the composed web profile references
 * resolves inside the staged runtime. Cordis resolves bare plugin names from
 * node_modules; a plugin the profile composes but the runtime omits fails only
 * at the user's first launch, so packaging rejects it up front.
 */
async function verifyProfilePlugins(): Promise<void> {
  const bundles = ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-base']
  const referenced = new Set<string>()
  for (const bundle of bundles) {
    const bundleRoot = join(staging, 'node_modules', bundle)
    if (!existsSync(bundleRoot)) throw new Error(`desktop runtime missing web profile bundle: ${bundle}`)
    for (const file of globSync('**/*.yml', { cwd: bundleRoot })) {
      const text = await readFile(join(bundleRoot, file), 'utf8')
      for (const match of text.matchAll(/name:\s*['"]?(@deepseek-ai\/dsh-[A-Za-z0-9._-]+)/gu)) {
        const name = match[1]
        if (name !== undefined) referenced.add(name)
      }
    }
  }
  const missing = [...referenced].filter(name => !existsSync(join(staging, 'node_modules', name, 'package.json')))
  if (missing.length > 0) {
    throw new Error(
      `desktop runtime is missing web-profile plugins: ${missing.join(', ')}. `
      + 'Regenerate with: pnpm --filter @deepseek-ai/dsh-desktop run generate-runtime-manifest',
    )
  }
  console.log(`desktop runtime profile check: ${referenced.size} composed plugins present`)
}

async function readFingerprint(): Promise<StageFingerprint | undefined> {
  if (!existsSync(fingerprintFile)) return undefined
  try {
    return JSON.parse(await readFile(fingerprintFile, 'utf8')) as StageFingerprint
  } catch {
    return undefined
  }
}

/** Collect one (size, mtime) stamp per file under a tree, skipping node_modules at any depth. */
async function stampTree(root: string, stamps: Map<string, string>, base: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(root, entry.name)
    const relative = path.slice(base.length + 1).replaceAll(sep, '/')
    if (entry.isDirectory()) {
      await stampTree(path, stamps, base)
    } else {
      const metadata = await lstat(path)
      stamps.set(relative, `${metadata.size}:${metadata.mtimeMs}`)
    }
  }
}

/**
 * Fingerprint every input that determines the staged runtime-host content:
 * the lockfile, the regenerated deploy manifest, and the file stamps of every
 * workspace package the manifest includes. An unchanged fingerprint reuses the
 * staged tree and skips the full pnpm deploy and symlink materialization.
 */
async function computeFingerprint(): Promise<string> {
  const hash = createHash('sha256')
  hash.update(String(STAGE_CACHE_VERSION))
  hash.update(await readFile(join(repositoryRoot, 'pnpm-lock.yaml')))
  hash.update(await readFile(join(desktopRoot, 'runtime', 'package.json')))
  for (const relative of globSync(workspaceManifestGlobs, { cwd: repositoryRoot }).sort()) {
    const manifestPath = join(repositoryRoot, relative)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string }
    if (manifest.name === undefined || RUNTIME_EXCLUDED_PACKAGES.has(manifest.name)) continue
    hash.update(manifest.name)
    hash.update(await readFile(manifestPath))
    const stamps = new Map<string, string>()
    await stampTree(dirname(manifestPath), stamps, dirname(manifestPath))
    for (const [path, stamp] of [...stamps.entries()].sort()) {
      hash.update(`${path}=${stamp};`)
    }
  }
  return hash.digest('hex')
}

/**
 * Remove compile-time-only declaration and source-map files from the staged
 * runtime. Node never loads `*.d.ts` or `*.map` at runtime, and the deepest
 * generated declaration names exceed MAX_PATH once installed, which makes the
 * NSIS uninstaller abort on them.
 * @returns Count and bytes of the removed files.
 */
async function pruneRuntime(): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const pending: string[] = [staging]
  while (pending.length > 0) {
    const dir = pending.pop() as string
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
      } else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.map')) {
        const metadata = await lstat(path)
        bytes += metadata.size
        await rm(path, { force: true })
        files += 1
      }
    }
  }
  return { files, bytes }
}

async function main(): Promise<void> {
  await run(process.execPath, ['--import', 'tsx', join(desktopRoot, 'scripts/generate-runtime-manifest.ts')])
  await run(process.execPath, [
    '--import', 'tsx', 'scripts/verify-runtime-closure.ts',
    '--manifest', 'apps/desktop/runtime/package.json',
  ])
  const fingerprint = await computeFingerprint()
  const stored = await readFingerprint()
  if (process.argv.includes('--force')
    || stored === undefined
    || stored.version !== STAGE_CACHE_VERSION
    || stored.hash !== fingerprint) {
    await rm(staging, { recursive: true, force: true })
    await deploy()
    await restoreLegacyHoists()
    await materializeLinks()
    const pruned = await pruneRuntime()
    await writeFile(fingerprintFile, JSON.stringify({ version: STAGE_CACHE_VERSION, hash: fingerprint }, undefined, 2))
    console.log(`desktop runtime staged at ${staging} (pruned ${pruned.files} files, ${(pruned.bytes / 1024 / 1024).toFixed(1)} MB)`)
  } else {
    console.log('desktop runtime staging: cache hit, reusing staged runtime-host')
  }
  await verifyProfilePlugins()
  if (!existsSync(entry)) throw new Error(`desktop Host entry missing after staging: ${entry}`)
  if (!existsSync(frontend)) throw new Error(`desktop Web frontend missing after staging: ${frontend}`)
}

await main()
