/**
 * Remote Host runtime bootstrap for the packaged desktop shell.
 *
 * The packaged app can run its Host from the runtime bundled into the
 * installer (`resources/host`) or from a runtime downloaded on first launch
 * and installed under the per-user data directory. This module owns the
 * remote path: fetch the runtime manifest, download the archive, verify its
 * SHA-256, stream the ZIP into a staging directory, and atomically swap it
 * into place. It imports no Electron APIs so the whole flow runs under plain
 * Node in unit tests.
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { finished } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { Unzip, UnzipInflate, type UnzipFile } from 'fflate'

/** One ordered byte slice of the runtime archive, downloaded in parallel. */
export interface RuntimePart {
  /** Attachment file name (also the last URL path segment). */
  readonly name: string
  /** Absolute http(s) URL of this part. */
  readonly url: string
  /** Lowercase hex SHA-256 of this part's bytes. */
  readonly sha256: string
  /** Byte length of this part. */
  readonly size: number
}

/** Runtime manifest served beside the downloadable runtime archive. */
export interface RuntimeManifest {
  /** Content-addressed version of the archive (app version plus stage hash). */
  readonly version: string
  /** Absolute http(s) URL of the ZIP archive to download. */
  readonly url: string
  /** Lowercase hex SHA-256 of the archive bytes. */
  readonly sha256: string
  /** Compressed size in bytes when the server reports one. */
  readonly size?: number
  /**
   * Optional ordered slices of the archive. When present, the shell downloads
   * every part in parallel (Gitee caps each connection at ~2 MB/s, so parallel
   * connections multiply throughput) and concatenates them before verifying
   * the whole-archive SHA-256. Absent for hosts that only offer the full zip.
   */
  readonly parts?: readonly RuntimePart[]
}

/** One progress observation from the bootstrap flow. */
export interface BootstrapProgress {
  /** Current step of the flow. */
  readonly phase: 'fetching-manifest' | 'downloading' | 'extracting' | 'installing' | 'ready'
  /** 0-100 percentage of the step, undefined while unmeasurable. */
  readonly percent?: number
  /** Optional human-readable detail for the progress surface. */
  readonly detail?: string
}

/** Result of one bootstrap pass. */
export interface BootstrapOutcome {
  /** Absolute path of the runtime directory the Host should launch from. */
  readonly runtimeDir: string
  /** True when this pass downloaded and installed a new runtime. */
  readonly downloaded: boolean
  /** Version of the runtime in effect after the pass. */
  readonly version: string
}

/** Options for {@link ensureRuntime}. */
export interface RuntimeBootstrapOptions {
  /** URL of the runtime manifest. */
  readonly manifestUrl: string
  /** Absolute path of the directory that holds the installed runtime. */
  readonly runtimeDir: string
  /** Path relative to runtimeDir that must exist after extraction (the Host CLI entry). */
  readonly hostEntry: string
  /** ZIP extraction implementation; defaults to the serial extractor. */
  readonly extractArchive?: (archivePath: string, destination: string, onBytes?: (read: number, total: number) => void) => Promise<void>
  /** Receives progress observations; optional for silent callers. */
  readonly onProgress?: (progress: BootstrapProgress) => void
  /** HTTP client; defaults to the global fetch. */
  readonly fetch?: typeof fetch
  /** Overall per-attempt timeout in milliseconds (default 300000). */
  readonly downloadTimeoutMs?: number
  /** Abort an attempt that receives no bytes for this long in milliseconds (default 20000). */
  readonly downloadStallTimeoutMs?: number
  /** Extra attempts per candidate URL after the first failure (default 1). */
  readonly downloadRetries?: number
  /**
   * Number of parallel connections used when the manifest publishes parts
   * (default 8). Gitee throttles each connection, so more connections speed up
   * the download up to the host's connection cap.
   */
  readonly downloadConcurrency?: number
  /**
   * Prefixes prepended to the archive URL for fallback attempts, tried after
   * the primary URL is exhausted. Mirrors must serve the identical bytes;
   * the manifest SHA-256 still gates every attempt.
   */
  readonly mirrorPrefixes?: readonly string[]
  /**
   * Pre-sorted download candidate URLs (fastest first). When provided,
   * overrides the [manifest.url, ...mirrorPrefixes] ordering so the
   * fastest path is tried first instead of the built-in primary + mirrors.
   */
  readonly candidates?: readonly string[]
  /**
   * Skip the update check and use the installed runtime as-is. An absent
   * install still bootstraps (the app cannot run without a Host); a present
   * one is trusted without consulting the manifest.
   */
  readonly skipUpdateCheck?: boolean
}

/** Marker written inside an installed runtime directory. */
const MANIFEST_FILE = 'runtime-manifest.json'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u

/** Reject a fetched manifest whose fields cannot drive a bootstrap. */
export function validateManifest(manifest: RuntimeManifest): void {
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('runtime manifest has no version')
  }
  if (typeof manifest.url !== 'string' || !/^https?:\/\//u.test(manifest.url)) {
    throw new Error('runtime manifest has no http(s) archive URL')
  }
  if (typeof manifest.sha256 !== 'string' || !SHA256_PATTERN.test(manifest.sha256)) {
    throw new Error('runtime manifest has no valid sha256')
  }
  if (manifest.parts !== undefined) {
    if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) {
      throw new Error('runtime manifest has an invalid parts list')
    }
    for (const part of manifest.parts) {
      if (
        typeof part.name !== 'string' || part.name.length === 0 ||
        typeof part.url !== 'string' || !/^https?:\/\//u.test(part.url) ||
        typeof part.sha256 !== 'string' || !SHA256_PATTERN.test(part.sha256) ||
        typeof part.size !== 'number' || !Number.isFinite(part.size) || part.size <= 0
      ) {
        throw new Error('runtime manifest has an invalid part')
      }
    }
  }
}

/** Clamp a byte ratio to a 0-100 integer, or undefined while the total is unknown. */
function percentOf(part: number, total: number | undefined): number | undefined {
  if (total === undefined || total <= 0) return undefined
  return Math.min(100, Math.max(0, Math.round((part / total) * 100)))
}

/** Build one progress observation, omitting optional fields that are undefined. */
function progressOf(
  phase: BootstrapProgress['phase'],
  percent?: number,
  detail?: string,
): BootstrapProgress {
  return {
    phase,
    ...(percent === undefined ? {} : { percent }),
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Read the version of an installed runtime, or undefined when absent or
 * incomplete. A missing Host entry or an unreadable marker means the install
 * is unusable and must be replaced.
 */
export async function readInstalledVersion(runtimeDir: string, hostEntry: string): Promise<string | undefined> {
  if (!existsSync(join(runtimeDir, hostEntry))) return undefined
  try {
    const parsed = JSON.parse(await readFile(join(runtimeDir, MANIFEST_FILE), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : undefined
  } catch {
    // No marker (or an unreadable one) means no version to trust; the caller re-downloads.
    return undefined
  }
}

/**
 * Fetch and validate the runtime manifest.
 * @param url - Manifest URL served beside the downloadable runtime archive.
 * @param fetchImpl - HTTP client; defaults to the global fetch.
 * @returns The validated runtime manifest.
 */
export async function fetchRuntimeManifest(url: string, fetchImpl: typeof fetch = fetch): Promise<RuntimeManifest> {
  const response = await fetchImpl(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`runtime manifest fetch failed: HTTP ${response.status} for ${url}`)
  }
  const manifest = (await response.json()) as RuntimeManifest
  validateManifest(manifest)
  return manifest
}

/**
 * Fetch and validate the runtime manifest, falling back to mirror prefixes
 * when the primary URL fails. Mirrors must serve the identical bytes; the
 * archive SHA-256 still gates the download that follows.
 * @param url - Primary manifest URL.
 * @param fetchImpl - HTTP client.
 * @param mirrors - Prefixes prepended to the URL for fallback attempts.
 * @returns The validated runtime manifest.
 */
export async function fetchRuntimeManifestWithMirrors(
  url: string,
  fetchImpl: typeof fetch,
  mirrors: readonly string[],
): Promise<RuntimeManifest> {
  const candidates = [url, ...mirrors.map(mirror => `${mirror}${url}`)]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return await fetchRuntimeManifest(candidate, fetchImpl)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`runtime manifest fetch failed for ${url}`, { cause: lastError })
}

/** Per-attempt download bounds: an overall cap and a no-progress watchdog. */
interface DownloadLimits {
  readonly timeoutMs: number
  readonly stallTimeoutMs: number
}

/**
 * Download an archive to a file, hashing the bytes as they stream. The fetch
 * is aborted when the attempt exceeds {@link DownloadLimits.timeoutMs} or when
 * no bytes arrive for {@link DownloadLimits.stallTimeoutMs}, so a stalled
 * connection (a common failure on flaky links to release CDNs) fails instead
 * of hanging forever and lets the caller retry or switch mirrors.
 * @returns The destination path and the SHA-256 of the downloaded bytes.
 */
async function downloadArchive(
  fetchImpl: typeof fetch,
  url: string,
  destination: string,
  onBytes: ((received: number, total?: number) => void) | undefined,
  limits: DownloadLimits,
): Promise<{ path: string; sha256: string }> {
  const controller = new AbortController()
  const startedAt = Date.now()
  let lastByteAt = startedAt
  const watchdog = setInterval(() => {
    const elapsed = Date.now() - startedAt
    const idle = Date.now() - lastByteAt
    if (elapsed >= limits.timeoutMs || idle >= limits.stallTimeoutMs) controller.abort()
  }, 250)
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) {
      throw new Error(`runtime archive download failed: HTTP ${response.status} for ${url}`)
    }
    if (response.body === null) throw new Error(`runtime archive download failed: empty body for ${url}`)
    const totalHeader = response.headers.get('content-length')
    const total = totalHeader === null ? undefined : Number(totalHeader)
    await mkdir(dirname(destination), { recursive: true })
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
    const writer = createWriteStream(destination)
    const hash = createHash('sha256')
    let received = 0
    try {
      for await (const chunk of source) {
        const bytes = chunk as Buffer
        hash.update(bytes)
        received += bytes.length
        lastByteAt = Date.now()
        onBytes?.(received, total)
        if (!writer.write(bytes)) await new Promise<void>(accept => writer.once('drain', accept))
      }
      writer.end()
      await finished(writer)
    } catch (error) {
      writer.destroy()
      throw error
    }
    return { path: destination, sha256: hash.digest('hex') }
  } finally {
    clearInterval(watchdog)
  }
}

/**
 * Download every part of a split archive in parallel, verify each part's own
 * SHA-256, then concatenate them in order and return the combined SHA-256.
 *
 * Gitee throttles each connection to roughly 2 MB/s, so pulling N parts over
 * N connections multiplies throughput nearly linearly (measured ~7.5 MB/s at
 * 4 ways and ~13.5 MB/s at 8). The caller still verifies the concatenation
 * against the manifest sha256 before installing.
 */
async function downloadPartsInParallel(
  fetchImpl: typeof fetch,
  parts: readonly RuntimePart[],
  downloadDir: string,
  onBytes: ((received: number, total: number) => void) | undefined,
  limits: DownloadLimits,
  concurrency: number,
): Promise<string> {
  const total = parts.reduce((sum, part) => sum + part.size, 0)
  let received = 0
  let next = 0
  const partPaths: string[] = []

  const worker = async (): Promise<void> => {
    while (next < parts.length) {
      const index = next
      next += 1
      const part = parts[index]
      const path = join(downloadDir, `part-${index}`)
      partPaths[index] = path
      // Each part is fetched with its own stall watchdog; onBytes is left off
      // per-part so the aggregate progress below is the only progress signal.
      const result = await downloadArchive(fetchImpl, part.url, path, undefined, limits)
      if (result.sha256 !== part.sha256) {
        throw new Error(`runtime part ${index} checksum mismatch (expected ${part.sha256}, got ${result.sha256})`)
      }
      received += part.size
      onBytes?.(received, total)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, parts.length) }, () => worker())
  await Promise.all(workers)

  // Concatenate parts in order into the single archive file.
  const archivePath = join(downloadDir, 'runtime.zip')
  const writer = createWriteStream(archivePath)
  const hash = createHash('sha256')
  try {
    for (let index = 0; index < parts.length; index += 1) {
      for await (const chunk of createReadStream(partPaths[index])) {
        const bytes = chunk as Buffer
        hash.update(bytes)
        if (!writer.write(bytes)) await new Promise<void>(accept => writer.once('drain', accept))
      }
    }
    writer.end()
    await finished(writer)
  } catch (error) {
    writer.destroy()
    throw error
  }
  return hash.digest('hex')
}

/**
 * Stream a ZIP archive onto disk under destination, creating directories on
 * demand and rejecting entries that would escape the destination root.
 * @param archivePath - Path of the ZIP archive.
 * @param destination - Root directory to extract into (recreated first).
 * @param onBytes - Receives the compressed bytes consumed so far.
 */
export async function extractZip(
  archivePath: string,
  destination: string,
  onBytes?: (read: number, total: number) => void,
): Promise<void> {
  const base = resolve(destination)
  const total = (await stat(archivePath)).size
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  const unzip = new Unzip()
  unzip.register(UnzipInflate)
  const writes: Array<Promise<void>> = []
  const createdDirs = new Set<string>()
  let failure: Error | undefined

  unzip.onfile = (file) => {
    if (failure !== undefined) return
    const name = file.name.replaceAll('\\', '/')
    if (name === '' || name.endsWith('/')) return
    const target = resolve(base, name)
    if (target !== base && !target.startsWith(base + sep)) {
      failure = new Error(`runtime archive entry escapes destination: ${name}`)
      return
    }
    const parent = dirname(target)
    if (!createdDirs.has(parent)) {
      mkdirSync(parent, { recursive: true })
      createdDirs.add(parent)
    }
    writes.push(writeZipEntry(file, target))
  }

  let read = 0
  try {
    for await (const chunk of createReadStream(archivePath)) {
      const bytes = chunk as Buffer
      unzip.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), false)
      read += bytes.length
      onBytes?.(read, total)
      if (failure !== undefined) throw failure
    }
    unzip.push(new Uint8Array(0), true)
    await Promise.all(writes)
  } finally {
    if (failure !== undefined) throw failure
  }
}

/** Stream one ZIP entry to its destination file, resolving when it flushes. */
function writeZipEntry(file: UnzipFile, target: string): Promise<void> {
  return new Promise<void>((accept, decline) => {
    const stream = createWriteStream(target, { flags: 'wx' })
    let settled = false
    stream.on('error', (error) => {
      if (settled) return
      settled = true
      decline(error)
    })
    stream.on('finish', () => {
      if (settled) return
      settled = true
      accept()
    })
    file.ondata = (error, chunk, final) => {
      if (error !== null) {
        if (!settled) {
          settled = true
          decline(error)
        }
        return
      }
      stream.write(chunk)
      if (final) stream.end()
    }
    file.start()
  })
}

/** Move a staged runtime into place, keeping the previous install until the swap lands. */
async function installStagedRuntime(stagingDir: string, runtimeDir: string, manifest: RuntimeManifest): Promise<void> {
  await writeFile(join(stagingDir, MANIFEST_FILE), `${JSON.stringify(manifest, undefined, 2)}\n`)
  const oldDir = `${runtimeDir}.old`
  if (existsSync(runtimeDir)) await rename(runtimeDir, oldDir)
  try {
    await rename(stagingDir, runtimeDir)
  } catch (error) {
    if (existsSync(oldDir)) {
      await rename(oldDir, runtimeDir).catch(() => {})
    }
    throw error
  }
  await rm(oldDir, { recursive: true, force: true })
}

/**
 * Ensure the requested remote runtime is installed and current.
 *
 * When the installed version already matches the manifest, the existing
 * install is left untouched. Otherwise the archive is downloaded, verified
 * against the manifest SHA-256, extracted to a staging directory, and swapped
 * in. Any failure cleans up the staging and download directories and rejects.
 * @param options - Manifest URL, install directory, host entry and progress.
 * @returns The runtime directory and whether a fresh install happened.
 */
export async function ensureRuntime(options: RuntimeBootstrapOptions): Promise<BootstrapOutcome> {
  const fetchImpl = options.fetch ?? fetch
  const report = (progress: BootstrapProgress): void => options.onProgress?.(progress)

  // A user who declined the app update gets no background runtime download
  // either; use the installed runtime as-is. A missing install still needs a
  // bootstrap or the app cannot start, so only the present case short-circuits.
  if (options.skipUpdateCheck === true) {
    const installed = await readInstalledVersion(options.runtimeDir, options.hostEntry)
    if (installed !== undefined) {
      report(progressOf('ready', 100, installed))
      return { runtimeDir: options.runtimeDir, downloaded: false, version: installed }
    }
  }

  report(progressOf('fetching-manifest'))
  const manifest = await fetchRuntimeManifestWithMirrors(
    options.manifestUrl,
    fetchImpl,
    options.mirrorPrefixes ?? [],
  )

  const installed = await readInstalledVersion(options.runtimeDir, options.hostEntry)
  if (installed === manifest.version) {
    report(progressOf('ready', 100, manifest.version))
    return { runtimeDir: options.runtimeDir, downloaded: false, version: manifest.version }
  }

  const stagingDir = `${options.runtimeDir}.new`
  const downloadDir = `${options.runtimeDir}.download`
  await rm(stagingDir, { recursive: true, force: true })
  await rm(downloadDir, { recursive: true, force: true })
  try {
    const archivePath = join(downloadDir, 'runtime.zip')
    const retries = options.downloadRetries ?? 1
    const limits = {
      timeoutMs: options.downloadTimeoutMs ?? 300_000,
      stallTimeoutMs: options.downloadStallTimeoutMs ?? 20_000,
    }
    const candidates = options.candidates ?? [
      manifest.url,
      ...(options.mirrorPrefixes ?? []).map(prefix => `${prefix}${manifest.url}`),
    ]
    let downloaded: { path: string; sha256: string } | undefined
    let lastError: unknown

    // Parallel path: the manifest optionally lists ordered slices served as
    // independent attachments. Gitee caps each connection (~2 MB/s), so
    // downloading every part at once multiplies throughput nearly linearly.
    // The whole concatenation is still verified against manifest.sha256.
    if (manifest.parts !== undefined && manifest.parts.length > 1) {
      report(progressOf('downloading', 0, `parallel ${manifest.parts.length}-way`))
      try {
        const combinedSha = await downloadPartsInParallel(
          fetchImpl,
          manifest.parts,
          downloadDir,
          (received, total) => { report(progressOf('downloading', percentOf(received, total))) },
          limits,
          options.downloadConcurrency ?? 8,
        )
        if (combinedSha !== manifest.sha256) {
          throw new Error(`runtime archive checksum mismatch (expected ${manifest.sha256}, got ${combinedSha})`)
        }
        downloaded = { path: archivePath, sha256: combinedSha }
      } catch (error) {
        lastError = error
      }
    }

    // Fallback: single serial download from the archive URL (or mirrors).
    if (downloaded === undefined) {
      for (const candidate of candidates) {
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          await rm(archivePath, { force: true }).catch(() => {})
          report(progressOf('downloading', 0, attempt > 0 ? `attempt ${attempt + 1} of ${candidate}` : undefined))
          try {
            const result = await downloadArchive(
              fetchImpl,
              candidate,
              archivePath,
              (received, total) => { report(progressOf('downloading', percentOf(received, total))) },
              limits,
            )
            if (result.sha256 !== manifest.sha256) {
              throw new Error(`runtime archive checksum mismatch (expected ${manifest.sha256}, got ${result.sha256})`)
            }
            downloaded = result
            break
          } catch (error) {
            lastError = error
          }
        }
        if (downloaded !== undefined) break
      }
      if (downloaded === undefined) {
        const reason = lastError instanceof Error ? lastError.message : String(lastError)
        throw new Error(
          `runtime archive download failed after ${candidates.length * (retries + 1)} attempt(s): ${reason}`,
          { cause: lastError },
        )
      }
    }

    report(progressOf('extracting', 0))
    const extract = options.extractArchive ?? extractZip
    await extract(archivePath, stagingDir, (read, total) => { report(progressOf('extracting', percentOf(read, total))) })
    if (!existsSync(join(stagingDir, options.hostEntry))) {
      throw new Error(`runtime archive is missing Host entry: ${options.hostEntry}`)
    }

    report(progressOf('installing', 90))
    await installStagedRuntime(stagingDir, options.runtimeDir, manifest)
    await rm(downloadDir, { recursive: true, force: true })
    report(progressOf('ready', 100, manifest.version))
    return { runtimeDir: options.runtimeDir, downloaded: true, version: manifest.version }
  } catch (error) {
    await Promise.all([
      rm(stagingDir, { recursive: true, force: true }),
      rm(downloadDir, { recursive: true, force: true }),
      rm(`${options.runtimeDir}.old`, { recursive: true, force: true }),
    ])
    throw error
  }
}
