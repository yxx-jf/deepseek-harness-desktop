/** Worker entry that inflates and writes one slice of a runtime archive. */

import { open, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { inflateSync } from 'fflate'

/** One entry handed to the worker; a subset of {@link ZipEntry}. */
interface WorkerEntry {
  readonly name: string
  readonly method: number
  readonly compressedSize: number
  readonly dataOffset: number
}

interface ExtractRequest {
  readonly archivePath: string
  readonly destination: string
  readonly entries: readonly WorkerEntry[]
}

const port = parentPort
if (port !== null) {
  port.on('message', (request: ExtractRequest) => {
    void run(request)
  })
}

/** Inflate and write every entry in the slice, reporting cumulative progress. */
async function run(request: ExtractRequest): Promise<void> {
  const base = resolve(request.destination)
  const fd = await open(request.archivePath, 'r')
  let progress = 0
  try {
    for (const entry of request.entries) {
      const target = resolve(base, entry.name)
      if (target !== base && !target.startsWith(base + sep)) {
        throw new Error(`runtime archive entry escapes the destination: ${entry.name}`)
      }
      const buffer = Buffer.alloc(entry.compressedSize)
      await fd.read(buffer, 0, entry.compressedSize, entry.dataOffset)
      const data = entry.method === 8
        ? inflateSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
        : buffer
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data)
      progress += entry.compressedSize
      port?.postMessage({ type: 'progress', bytes: progress })
    }
    port?.postMessage({ type: 'complete' })
  } catch (error) {
    port?.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    await fd.close()
  }
}
