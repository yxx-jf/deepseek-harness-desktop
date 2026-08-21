/**
 * Package the staged desktop Host runtime into a downloadable ZIP plus a
 * runtime manifest, and optionally point the packaged shell at the manifest.
 *
 * The archive contains the flat runtime-host tree (package.json plus
 * node_modules) that the desktop shell extracts into its user data directory
 * on first launch. The manifest records the content-addressed version, the
 * archive URL, and the SHA-256 the shell verifies before installing. Host the
 * archive and the manifest beside each other under the same base URL, then
 * rebuild the installer with --write-config so the shell knows where to look.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = existsSync(join(desktopRoot, 'upstream', 'package.json'))
  ? join(desktopRoot, 'upstream')
  : desktopRoot
const staging = join(desktopRoot, 'runtime-host')
const fingerprintFile = join(staging, '.stage-fingerprint.json')
const hostEntry = join(staging, 'node_modules/@deepseek-ai/dsh/lib/bin.js')

/** Published runtime manifest consumed by the desktop shell. */
interface RuntimeManifest {
  readonly version: string
  readonly url: string
  readonly sha256: string
  readonly size: number
}

interface PublishOptions {
  readonly baseUrl: string
  readonly writeConfig: boolean
  readonly outDir: string
}

/** Parse the CLI, defaulting the base URL to DSH_RUNTIME_PUBLISH_URL. */
function parseArgs(argv: readonly string[]): PublishOptions {
  let baseUrl = process.env.DSH_RUNTIME_PUBLISH_URL
  let writeConfig = false
  let outDir = join(desktopRoot, 'dist', 'runtime')
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]
    if (argument === '--url') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('publish-runtime: --url requires a base URL argument')
      baseUrl = value
      i += 1
    } else if (argument === '--write-config') {
      writeConfig = true
    } else if (argument === '--out') {
      const value = argv[i + 1]
      if (value === undefined) throw new Error('publish-runtime: --out requires a directory argument')
      outDir = resolve(value)
      i += 1
    } else {
      throw new Error(`publish-runtime: unknown argument ${argument}`)
    }
  }
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error('publish-runtime: missing base URL (pass --url or set DSH_RUNTIME_PUBLISH_URL)')
  }
  return { baseUrl: baseUrl.replace(/\/+$/u, ''), writeConfig, outDir }
}

/** Re-stage the runtime so the published archive always matches the checkout. */
async function runStageRuntime(): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(desktopRoot, 'scripts/stage-runtime.ts')], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) accept()
      else reject(new Error(`publish-runtime: stage-runtime exited with code ${String(code)}`))
    })
  })
}

/** Every regular file under root, directories traversed depth-first. */
async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop() as string
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return files
}

/** Fixed ZIP timestamp (1980-01-01) so the archive is reproducible. */
const ZIP_MTIME = new Date('2020-01-01T00:00:00Z')

/**
 * ZIP a directory tree with level-9 DEFLATE and a fixed timestamp.
 *
 * fflate's streaming Zip writer (Zip/ZipDeflate) corrupts some inputs in
 * 0.8.3 (inflate reports `invalid distance` on round-trip), so the archive is
 * built with the validated synchronous zipSync instead. The staged tree is
 * ~500 MB, which is acceptable for a one-shot publish step.
 * @returns The archive SHA-256 and compressed size.
 */
async function createRuntimeArchive(sourceRoot: string, outFile: string): Promise<{ sha256: string; size: number }> {
  await mkdir(dirname(outFile), { recursive: true })
  const files: Record<string, Uint8Array> = {}
  for (const file of (await walkFiles(sourceRoot)).sort()) {
    const name = relative(sourceRoot, file).split(sep).join('/')
    if (name === '.stage-fingerprint.json') continue
    files[name] = await readFile(file)
  }
  const archive = zipSync(files, { level: 9, mtime: ZIP_MTIME })
  await writeFile(outFile, archive)
  const hash = createHash('sha256')
  hash.update(archive)
  return { sha256: hash.digest('hex'), size: archive.byteLength }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  await runStageRuntime()

  // Purge stale outputs from previous runs: content-addressed archive names
  // change between builds, so the output dir must hold only the current
  // zip + manifest or an uploader may ship a stale zip mismatching the manifest.
  await rm(join(options.outDir, 'runtime-manifest.json'), { force: true })
  for (const entry of await readdir(options.outDir).catch(() => [])) {
    if (entry.startsWith('dsh-runtime-') && entry.endsWith('.zip')) {
      await rm(join(options.outDir, entry), { force: true, recursive: false })
    }
  }

  if (!existsSync(hostEntry)) {
    throw new Error(`publish-runtime: staged Host entry is missing: ${hostEntry}`)
  }
  const fingerprint = JSON.parse(await readFile(fingerprintFile, 'utf8')) as { hash?: unknown }
  if (typeof fingerprint.hash !== 'string' || fingerprint.hash.length === 0) {
    throw new Error(`publish-runtime: invalid stage fingerprint at ${fingerprintFile}`)
  }
  const desktopManifest = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8')) as { version?: unknown }
  const appVersion = typeof desktopManifest.version === 'string' ? desktopManifest.version : '0.0.0'
  const runtimeVersion = `${appVersion}-${fingerprint.hash.slice(0, 12)}`
  const archiveName = `dsh-runtime-${runtimeVersion}.zip`

  const archivePath = join(options.outDir, archiveName)
  const { sha256, size } = await createRuntimeArchive(staging, archivePath)
  const manifest: RuntimeManifest = {
    version: runtimeVersion,
    url: `${options.baseUrl}/${archiveName}`,
    sha256,
    size,
  }
  await writeFile(join(options.outDir, 'runtime-manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

  if (options.writeConfig) {
    const configPath = join(desktopRoot, 'resources', 'runtime-config.json')
    await writeFile(
      configPath,
      `${JSON.stringify({ manifestUrl: `${options.baseUrl}/runtime-manifest.json` }, undefined, 2)}\n`,
    )
    console.log(`publish-runtime: wrote shell config ${configPath}`)
  }

  console.log(`publish-runtime: ${archivePath} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256})`)
  console.log(`publish-runtime: manifest ${join(options.outDir, 'runtime-manifest.json')} -> ${manifest.url}`)
  console.log(`publish-runtime: host the archive and manifest under ${options.baseUrl}, then run dist:desktop`)
}

await main()
