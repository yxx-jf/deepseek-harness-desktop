/**
 * Parallel ZIP extraction: parse the central directory, distribute entries
 * across a bounded worker pool (each worker inflates and writes its slice),
 * and report archive-wide progress. Any failure rejects; callers fall back
 * to the serial extractor.
 */

import { existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { parseZipIndex, type ZipEntry } from './zip-index.ts'

/** Upper bound on extraction workers, matching desktop core counts. */
const MAX_WORKERS = 16

export interface ParallelExtractOptions {
  /** Worker count; defaults to the machine's parallelism capped at MAX_WORKERS. */
  readonly concurrency?: number
  /** Worker entry URL; defaults to the bundled or source worker beside this module. */
  readonly workerUrl?: string
}

interface WorkerProgress {
  readonly type: 'progress'
  readonly bytes: number
}

interface WorkerComplete {
  readonly type: 'complete'
}

interface WorkerError {
  readonly type: 'error'
  readonly message: string
}

type WorkerMessage = WorkerProgress | WorkerComplete | WorkerError

/** Locate the extraction worker beside this module: the bundled `.js` when present, the source `.ts` otherwise. */
function resolveWorkerUrl(): string {
  const bundled = new URL('./extract-worker.js', import.meta.url)
  return fileURLToPath(existsSync(bundled) ? bundled : new URL('./extract-worker.ts', import.meta.url))
}

/**
 * Extract a ZIP archive with a pool of inflate-and-write workers.
 *
 * Entries are sorted by compressed size and round-robined across workers so
 * one large file does not stall a single slice. Progress reports the
 * compressed bytes written so far against the archive total.
 * @param archivePath - Path of the ZIP archive.
 * @param destination - Root directory to extract into (created fresh).
 * @param onBytes - Receives the compressed bytes consumed so far.
 * @param options - Worker count and worker entry URL overrides.
 */
export async function extractZipParallel(
  archivePath: string,
  destination: string,
  onBytes?: (read: number, total: number) => void,
  options: ParallelExtractOptions = {},
): Promise<void> {
  const entries = await parseZipIndex(archivePath)
  const total = entries.reduce((sum, entry) => sum + entry.compressedSize, 0)
  const cores = availableParallelism()
  const concurrency = Math.min(Math.max(cores, 1), MAX_WORKERS, Math.max(entries.length, 1))
  const workerUrl = options.workerUrl ?? resolveWorkerUrl()

  const sorted = [...entries].sort((a, b) => b.compressedSize - a.compressedSize)
  const slices: Array<ZipEntry[]> = Array.from({ length: concurrency }, () => [])
  let worker = 0
  for (const entry of sorted) {
    const slice = slices[worker]
    if (slice !== undefined) slice.push(entry)
    worker = (worker + 1) % concurrency
  }

  const perWorker = new Array<number>(concurrency).fill(0)
  let lastReported = 0
  const report = (): void => {
    const sum = perWorker.reduce((totalBytes, bytes) => totalBytes + bytes, 0)
    if (sum === lastReported) return
    lastReported = sum
    onBytes?.(sum, total)
  }

  await Promise.all(slices.map((slice, index) => runWorker(workerUrl, {
    archivePath,
    destination,
    entries: slice,
  }, (message) => {
    if (message.type === 'progress') {
      perWorker[index] = message.bytes
      report()
    }
  })))
  onBytes?.(total, total)
}

/** Drive one worker to completion, forwarding progress and settling on its verdict. */
function runWorker(
  workerUrl: string,
  request: { archivePath: string; destination: string; entries: readonly ZipEntry[] },
  onMessage: (message: WorkerMessage) => void,
): Promise<void> {
  return new Promise<void>((accept, decline) => {
    const worker = new Worker(workerUrl)
    let settled = false
    worker.once('error', (error) => {
      if (settled) return
      settled = true
      decline(error)
    })
    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      decline(new Error(`runtime extraction worker exited with code ${String(code)}`))
    })
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'complete') {
        if (settled) return
        settled = true
        accept()
        void worker.terminate()
      } else if (message.type === 'error') {
        if (settled) return
        settled = true
        decline(new Error(message.message))
        void worker.terminate()
      } else {
        onMessage(message)
      }
    })
    worker.postMessage(request)
  })
}
