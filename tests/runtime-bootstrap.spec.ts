/** Unit tests for the desktop remote runtime bootstrap. */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  ensureRuntime,
  extractZip,
  fetchRuntimeManifest,
  fetchRuntimeManifestWithMirrors,
  readInstalledVersion,
  validateManifest,
  type BootstrapProgress,
  type RuntimeManifest,
  type RuntimePart,
} from '../src/runtime-bootstrap.ts'

const HOST_ENTRY = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

interface TestServer {
  readonly baseUrl: string
  readonly requested: string[]
  setRoutes(routes: Record<string, Buffer>): void
  close(): Promise<void>
}

/**
 * Serve routes on an ephemeral loopback port. Routes can be replaced after
 * the server starts (the manifest must reference the server's own port).
 * With {@link stallFirstArchive} the first request to /runtime.zip writes a
 * few bytes and then hangs, so the client watchdog aborts the attempt.
 */
async function startServer(initial: Record<string, Buffer> = {}, options: { stallFirstArchive?: boolean } = {}): Promise<TestServer> {
  let routes = { ...initial }
  const requested: string[] = []
  const server: Server = createServer((request, response) => {
    const path = request.url ?? '/'
    requested.push(path)
    if (options.stallFirstArchive === true && path === '/runtime.zip' && requested.filter(p => p === '/runtime.zip').length === 1) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.write(Buffer.alloc(16))
      return
    }
    const body = routes[path]
    if (body === undefined) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
    })
    response.end(body)
  })
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requested,
    setRoutes: (replacement) => { routes = replacement },
    close: () => new Promise<void>((accept) => {
      server.close(() => { accept() })
      server.closeAllConnections?.()
    }),
  }
}

/** A ZIP that mirrors the published runtime layout, with a working Host entry. */
function hostArchive(extra: Record<string, Uint8Array> = {}): Buffer {
  return Buffer.from(zipSync({
    'package.json': strToU8('{"name":"@deepseek-ai/dsh-desktop-runtime"}'),
    [HOST_ENTRY]: strToU8('console.log("host")'),
    ...extra,
  }))
}

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    version: 'v1',
    url: 'http://placeholder.invalid/runtime.zip',
    sha256: '0'.repeat(64),
    ...overrides,
  }
}

/** Serve a manifest (against the live server) pointing at one archive. */
function runtimeRoutes(baseUrl: string, archive: Buffer, overrides: Partial<RuntimeManifest> = {}): Record<string, Buffer> {
  return {
    '/runtime-manifest.json': Buffer.from(JSON.stringify(manifest({
      url: `${baseUrl}/runtime.zip`,
      sha256: sha256Of(archive),
      ...overrides,
    }))),
    '/runtime.zip': archive,
  }
}

/** Split a buffer into `count` roughly equal byte slices (same math as the publisher). */
function splitBuffer(data: Buffer, count: number): Buffer[] {
  const size = Math.ceil(data.length / count)
  const parts: Buffer[] = []
  for (let i = 0; i < count; i += 1) {
    const start = i * size
    if (start >= data.length) break
    const end = Math.min(data.length, start + size)
    parts.push(data.subarray(start, end))
  }
  return parts
}

/** Build a manifest with ordered parts plus routes serving each part. */
function runtimeRoutesWithParts(
  baseUrl: string,
  archive: Buffer,
  partCount: number,
): { routes: Record<string, Buffer>; parts: RuntimePart[] } {
  const slices = splitBuffer(archive, partCount)
  const parts: RuntimePart[] = slices.map((slice, index) => ({
    name: `runtime.zip.part${index}`,
    url: `${baseUrl}/runtime.zip.part${index}`,
    sha256: sha256Of(slice),
    size: slice.length,
  }))
  const routes: Record<string, Buffer> = {
    '/runtime-manifest.json': Buffer.from(JSON.stringify(manifest({
      url: `${baseUrl}/runtime.zip`,
      sha256: sha256Of(archive),
      parts,
    }))),
    '/runtime.zip': archive,
  }
  parts.forEach((part, index) => {
    routes[`/runtime.zip.part${index}`] = slices[index]
  })
  return { routes, parts }
}

/** Install the given version into runtimeDir without touching the network. */
async function installLocally(version: string): Promise<void> {
  await mkdir(join(runtimeDir, dirname(HOST_ENTRY)), { recursive: true })
  await writeFile(join(runtimeDir, HOST_ENTRY), `host-${version}`)
  await writeFile(join(runtimeDir, 'runtime-manifest.json'), JSON.stringify({ version }))
}

let runtimeDir: string
let server: TestServer | undefined

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'dsh-runtime-test-'))
})

afterEach(async () => {
  const current = server
  server = undefined
  if (current !== undefined) await current.close()
  await rm(runtimeDir, { recursive: true, force: true })
  await rm(`${runtimeDir}.new`, { recursive: true, force: true })
  await rm(`${runtimeDir}.download`, { recursive: true, force: true })
  await rm(`${runtimeDir}.old`, { recursive: true, force: true })
})

describe('ensureRuntime', () => {
  it('downloads and installs the runtime on first launch', async () => {
    const archive = hostArchive()
    server = await startServer()
    server.setRoutes(runtimeRoutes(server.baseUrl, archive))
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
    })
    expect(outcome.downloaded).toBe(true)
    expect(outcome.version).toBe('v1')
    expect(outcome.runtimeDir).toBe(runtimeDir)
    expect(await readInstalledVersion(runtimeDir, HOST_ENTRY)).toBe('v1')
    expect(await readFile(join(runtimeDir, HOST_ENTRY), 'utf8')).toBe('console.log("host")')
    expect(server.requested).toContain('/runtime.zip')
    expect(existsSync(`${runtimeDir}.download`)).toBe(false)
    expect(existsSync(`${runtimeDir}.new`)).toBe(false)
  })

  it('reuses an up-to-date runtime without downloading', async () => {
    await installLocally('v1')
    server = await startServer({
      '/runtime-manifest.json': Buffer.from(JSON.stringify(manifest())),
    })
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
    })
    expect(outcome.downloaded).toBe(false)
    expect(outcome.version).toBe('v1')
    expect(server.requested).toEqual(['/runtime-manifest.json'])
  })

  it('uses the installed runtime as-is when the update check is skipped', async () => {
    await installLocally('v1')
    // A newer manifest exists, but skipping the check must not consult it.
    server = await startServer({
      '/runtime-manifest.json': Buffer.from(JSON.stringify(manifest({ version: 'v2' }))),
    })
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
      skipUpdateCheck: true,
    })
    expect(outcome.downloaded).toBe(false)
    expect(outcome.version).toBe('v1')
    expect(server.requested).toEqual([])
  })

  it('still bootstraps a missing runtime when the update check is skipped', async () => {
    const archive = hostArchive()
    server = await startServer()
    server.setRoutes(runtimeRoutes(server.baseUrl, archive))
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
      skipUpdateCheck: true,
    })
    expect(outcome.downloaded).toBe(true)
    expect(outcome.version).toBe('v1')
    expect(server.requested).toContain('/runtime.zip')
  })

  it('replaces a stale runtime', async () => {
    await installLocally('v0')
    const archive = hostArchive()
    server = await startServer()
    server.setRoutes(runtimeRoutes(server.baseUrl, archive))
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
    })
    expect(outcome.downloaded).toBe(true)
    expect(outcome.version).toBe('v1')
    expect(await readFile(join(runtimeDir, HOST_ENTRY), 'utf8')).toBe('console.log("host")')
  })

  it('re-downloads a runtime whose Host entry is missing', async () => {
    await mkdir(join(runtimeDir, dirname(HOST_ENTRY)), { recursive: true })
    await writeFile(join(runtimeDir, 'runtime-manifest.json'), JSON.stringify({ version: 'v1' }))
    const archive = hostArchive()
    server = await startServer()
    server.setRoutes(runtimeRoutes(server.baseUrl, archive))
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
    })
    expect(outcome.downloaded).toBe(true)
  })

  it('rejects a checksum mismatch and leaves the runtime untouched', async () => {
    const archive = hostArchive()
    server = await startServer()
    server.setRoutes(runtimeRoutes(server.baseUrl, archive, { sha256: 'f'.repeat(64) }))
    await expect(ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
      downloadRetries: 0,
    })).rejects.toThrow(/checksum mismatch/)
    expect(await readInstalledVersion(runtimeDir, HOST_ENTRY)).toBeUndefined()
    expect(existsSync(`${runtimeDir}.new`)).toBe(false)
    expect(existsSync(`${runtimeDir}.download`)).toBe(false)
  })

  it('rejects a corrupt archive', async () => {
    const garbage = Buffer.from('this is definitely not a zip archive')
    server = await startServer()
    server.setRoutes(runtimeRoutes(server.baseUrl, garbage))
    await expect(ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
    })).rejects.toThrow()
    expect(await readInstalledVersion(runtimeDir, HOST_ENTRY)).toBeUndefined()
  })

  it('rejects an archive missing the Host entry', async () => {
    const archive = Buffer.from(zipSync({ 'package.json': strToU8('{}') }))
    server = await startServer()
    server.setRoutes(runtimeRoutes(server.baseUrl, archive))
    await expect(ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
    })).rejects.toThrow(/missing Host entry/)
  })

  it('retries a stalled archive download and succeeds on the next attempt', async () => {
    const archive = hostArchive()
    server = await startServer({}, { stallFirstArchive: true })
    server.setRoutes(runtimeRoutes(server.baseUrl, archive))
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
      downloadStallTimeoutMs: 500,
      downloadRetries: 1,
    })
    expect(outcome.downloaded).toBe(true)
    expect(outcome.version).toBe('v1')
    expect(server.requested.filter(path => path === '/runtime.zip')).toHaveLength(2)
  })

  it('falls back to a mirror prefix when the primary archive URL fails', async () => {
    const archive = hostArchive()
    server = await startServer()
    const primaryUrl = `${server.baseUrl}/unreachable.zip`
    // The mirror prefix rewrites the URL to `base` + `primaryUrl`; the server
    // sees `/http://host:port/unreachable.zip` as the path portion.
    const mirrorPath = `/${server.baseUrl}/unreachable.zip`
    server.setRoutes({
      '/runtime-manifest.json': Buffer.from(JSON.stringify(manifest({ url: primaryUrl, sha256: sha256Of(archive) }))),
      [mirrorPath]: archive,
    })
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
      downloadRetries: 0,
      mirrorPrefixes: [`${server.baseUrl}/`],
    })
    expect(outcome.downloaded).toBe(true)
    expect(server.requested).toContain(mirrorPath)
  })

  it('rejects a manifest the server answers with an error status', async () => {
    server = await startServer()
    await expect(ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
    })).rejects.toThrow(/manifest fetch failed/)
  })

  it('reports progress phases in order', async () => {
    const archive = hostArchive()
    server = await startServer()
    server.setRoutes(runtimeRoutes(server.baseUrl, archive))
    const progress: BootstrapProgress[] = []
    await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
      onProgress: observation => progress.push(observation),
    })
    const phases = progress.map(observation => observation.phase)
    expect(phases[0]).toBe('fetching-manifest')
    expect(phases).toContain('downloading')
    expect(phases).toContain('extracting')
    expect(phases).toContain('installing')
    expect(phases[phases.length - 1]).toBe('ready')
    expect(progress[progress.length - 1].percent).toBe(100)
  })

  it('downloads split parts in parallel when the manifest publishes them', async () => {
    const archive = hostArchive()
    server = await startServer()
    const { routes } = runtimeRoutesWithParts(server.baseUrl, archive, 4)
    server.setRoutes(routes)
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
    })
    expect(outcome.downloaded).toBe(true)
    expect(outcome.version).toBe('v1')
    expect(await readInstalledVersion(runtimeDir, HOST_ENTRY)).toBe('v1')
    expect(await readFile(join(runtimeDir, HOST_ENTRY), 'utf8')).toBe('console.log("host")')
    // Every part is fetched; the single-file URL is never requested.
    for (let index = 0; index < 4; index += 1) {
      expect(server.requested).toContain(`/runtime.zip.part${index}`)
    }
    expect(server.requested).not.toContain('/runtime.zip')
    expect(existsSync(`${runtimeDir}.download`)).toBe(false)
  })

  it('falls back to the single archive when a part download fails', async () => {
    const archive = hostArchive()
    server = await startServer()
    const { routes } = runtimeRoutesWithParts(server.baseUrl, archive, 4)
    // Withhold part1: its fetch returns 404 and the parallel path must
    // fall back to the single-file archive URL.
    delete routes['/runtime.zip.part1']
    server.setRoutes(routes)
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
      downloadRetries: 0,
    })
    expect(outcome.downloaded).toBe(true)
    expect(outcome.version).toBe('v1')
    expect(await readInstalledVersion(runtimeDir, HOST_ENTRY)).toBe('v1')
    expect(server.requested).toContain('/runtime.zip.part1')
    expect(server.requested).toContain('/runtime.zip')
  })

  it('falls back to the single archive when a part checksum mismatches', async () => {
    const archive = hostArchive()
    server = await startServer()
    const { routes } = runtimeRoutesWithParts(server.baseUrl, archive, 4)
    // Corrupt part2's served bytes; the manifest still advertises the real
    // part SHA-256, so the per-part check fails and the parallel path must
    // fall back to the single-file archive URL.
    routes['/runtime.zip.part2'] = Buffer.from('corrupted bytes for part two')
    server.setRoutes(routes)
    const outcome = await ensureRuntime({
      manifestUrl: `${server.baseUrl}/runtime-manifest.json`,
      runtimeDir,
      hostEntry: HOST_ENTRY,
      downloadRetries: 0,
    })
    expect(outcome.downloaded).toBe(true)
    expect(await readInstalledVersion(runtimeDir, HOST_ENTRY)).toBe('v1')
    expect(server.requested).toContain('/runtime.zip.part2')
    expect(server.requested).toContain('/runtime.zip')
  })
})

describe('extractZip', () => {
  it('extracts a nested tree with many files and one large file byte-identically', async () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < 300; i += 1) {
      files[`node_modules/pkg-${Math.floor(i / 10)}/file-${i}.js`] = strToU8(`content ${i} `.repeat(40))
    }
    const large = new Uint8Array(1_500_000)
    for (let i = 0; i < large.length; i += 997) large[i] = i % 251
    files['node_modules/pkg-big/big.bin'] = large
    const archive = Buffer.from(zipSync(files))
    const archivePath = join(runtimeDir, 'tree.zip')
    await writeFile(archivePath, archive)
    const destination = join(runtimeDir, 'out')
    await extractZip(archivePath, destination)
    for (let i = 0; i < 300; i += 1) {
      const expected = strToU8(`content ${i} `.repeat(40))
      const actual = await readFile(join(destination, `node_modules/pkg-${Math.floor(i / 10)}/file-${i}.js`))
      expect(Buffer.compare(actual, Buffer.from(expected))).toBe(0)
    }
    const bigActual = await readFile(join(destination, 'node_modules/pkg-big/big.bin'))
    expect(Buffer.compare(bigActual, Buffer.from(large))).toBe(0)
  })

  it('rejects an archive entry that escapes the destination', async () => {
    const archive = Buffer.from(zipSync({ '../evil.txt': strToU8('pwned') }))
    const archivePath = join(runtimeDir, 'evil.zip')
    await writeFile(archivePath, archive)
    await expect(extractZip(archivePath, join(runtimeDir, 'out'))).rejects.toThrow(/escapes destination/)
    expect(existsSync(join(runtimeDir, 'evil.txt'))).toBe(false)
  })
})

describe('readInstalledVersion', () => {
  it('returns undefined when the Host entry is missing', async () => {
    expect(await readInstalledVersion(runtimeDir, HOST_ENTRY)).toBeUndefined()
  })

  it('returns undefined when the marker is unreadable', async () => {
    await mkdir(join(runtimeDir, dirname(HOST_ENTRY)), { recursive: true })
    await writeFile(join(runtimeDir, HOST_ENTRY), 'host')
    await writeFile(join(runtimeDir, 'runtime-manifest.json'), 'not json')
    expect(await readInstalledVersion(runtimeDir, HOST_ENTRY)).toBeUndefined()
  })
})

describe('validateManifest', () => {
  it('accepts a complete manifest', () => {
    expect(() => { validateManifest(manifest()) }).not.toThrow()
  })

  it('rejects a manifest without a version', () => {
    expect(() => { validateManifest(manifest({ version: '' })) }).toThrow(/no version/)
  })

  it('rejects a manifest with a non-http URL', () => {
    expect(() => { validateManifest(manifest({ url: 'ftp://example.com/runtime.zip' })) }).toThrow(/no http/)
  })

  it('rejects a manifest with an invalid sha256', () => {
    expect(() => { validateManifest(manifest({ sha256: 'zzz' })) }).toThrow(/sha256/)
  })

  it('accepts a manifest with valid parts', () => {
    const goodPart: RuntimePart = {
      name: 'runtime.zip.part0',
      url: 'http://example.com/runtime.zip.part0',
      sha256: '0'.repeat(64),
      size: 1024,
    }
    expect(() => { validateManifest(manifest({ parts: [goodPart] })) }).not.toThrow()
  })

  it('rejects a manifest with a non-http part URL', () => {
    const badPart: RuntimePart = {
      name: 'runtime.zip.part0',
      url: 'ftp://example.com/runtime.zip.part0',
      sha256: '0'.repeat(64),
      size: 1024,
    }
    expect(() => { validateManifest(manifest({ parts: [badPart] })) }).toThrow(/invalid part/)
  })

  it('rejects a manifest with an invalid part sha256', () => {
    const badPart: RuntimePart = {
      name: 'runtime.zip.part0',
      url: 'http://example.com/runtime.zip.part0',
      sha256: 'zzz',
      size: 1024,
    }
    expect(() => { validateManifest(manifest({ parts: [badPart] })) }).toThrow(/invalid part/)
  })
})

describe('fetchRuntimeManifest', () => {
  it('fetches and validates a served manifest', async () => {
    const server = await startServer()
    try {
      server.setRoutes({ '/manifest.json': strToU8(JSON.stringify(manifest())) })
      const fetched = await fetchRuntimeManifest(`${server.baseUrl}/manifest.json`)
      expect(fetched).toEqual(manifest())
      expect(server.requested).toContain('/manifest.json')
    } finally {
      await server.close()
    }
  })

  it('rejects a manifest the server answers with an error status', async () => {
    const server = await startServer()
    try {
      await expect(fetchRuntimeManifest(`${server.baseUrl}/missing.json`)).rejects.toThrow(/HTTP 404/)
    } finally {
      await server.close()
    }
  })

  it('rejects a served manifest that fails validation', async () => {
    const server = await startServer()
    try {
      server.setRoutes({ '/manifest.json': strToU8(JSON.stringify(manifest({ url: 'ftp://example.com/runtime.zip' }))) })
      await expect(fetchRuntimeManifest(`${server.baseUrl}/manifest.json`)).rejects.toThrow(/no http/)
    } finally {
      await server.close()
    }
  })

  it('falls back to a mirror prefix when the primary manifest fetch fails', async () => {
    const body = JSON.stringify(manifest())
    const fetchMock = vi.fn(async (url: unknown) => {
      const target = String(url)
      if (target.startsWith('http://primary.invalid')) return { ok: false, status: 502, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => JSON.parse(body) as RuntimeManifest }
    })
    const fetched = await fetchRuntimeManifestWithMirrors(
      'http://primary.invalid/runtime-manifest.json',
      fetchMock as never,
      ['http://mirror.example/'],
    )
    expect(fetched).toEqual(manifest())
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://primary.invalid/runtime-manifest.json')
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('http://mirror.example/http://primary.invalid/runtime-manifest.json')
  })

  it('rejects when every manifest candidate fails', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }))
    await expect(fetchRuntimeManifestWithMirrors(
      'http://primary.invalid/runtime-manifest.json',
      fetchMock as never,
      ['http://mirror.example/'],
    )).rejects.toThrow(/manifest fetch failed/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
