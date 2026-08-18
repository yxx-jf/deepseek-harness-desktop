/** Parse the ZIP central directory of a runtime archive into extractable entries. */

import { open } from 'node:fs/promises'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const EOCD_MIN_SIZE = 22
/** A ZIP comment can be up to 64 KiB, so the EOCD lives in the last 64 KiB plus its own header. */
const EOCD_SCAN_LIMIT = EOCD_MIN_SIZE + 65_535

/** One ZIP entry ready for parallel extraction. */
export interface ZipEntry {
  /** Entry path inside the archive, normalized to `/`. */
  readonly name: string
  /** Compression method: 0 = stored, 8 = deflate. */
  readonly method: number
  /** Compressed bytes in the archive. */
  readonly compressedSize: number
  /** Uncompressed bytes after inflation. */
  readonly uncompressedSize: number
  /** Absolute offset of the entry's compressed data in the archive. */
  readonly dataOffset: number
}

/**
 * Read and validate a ZIP's central directory.
 *
 * Entries are checked for path escape, encryption, and unsupported
 * compression. The local header's name/extra lengths are assumed equal to the
 * central directory's — true for the archives this repository publishes, and
 * a divergence makes a worker inflate fail, which the caller treats as a
 * fallback trigger rather than corruption.
 * @param archivePath - Path of the ZIP archive.
 * @returns The validated entries in archive order.
 */
export async function parseZipIndex(archivePath: string): Promise<ZipEntry[]> {
  const fd = await open(archivePath, 'r')
  try {
    const size = (await fd.stat()).size
    if (size < EOCD_MIN_SIZE) throw new Error(`runtime archive is too small to be a ZIP: ${archivePath}`)
    const tailLength = Math.min(size, EOCD_SCAN_LIMIT)
    const tail = Buffer.alloc(tailLength)
    await fd.read(tail, 0, tailLength, size - tailLength)

    let eocd = -1
    for (let index = tailLength - EOCD_MIN_SIZE; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
        eocd = index
        break
      }
    }
    if (eocd === -1) throw new Error(`runtime archive has no end-of-central-directory: ${archivePath}`)

    const diskNumber = tail.readUInt16LE(eocd + 4)
    const cdStartDisk = tail.readUInt16LE(eocd + 6)
    const entriesOnDisk = tail.readUInt16LE(eocd + 8)
    const totalEntries = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (diskNumber !== 0 || cdStartDisk !== 0) {
      throw new Error(`runtime archive uses a multi-disk layout: ${archivePath}`)
    }
    if (entriesOnDisk !== totalEntries || totalEntries === 0xffff) {
      throw new Error(`runtime archive uses zip64 extensions: ${archivePath}`)
    }

    const cd = Buffer.alloc(cdSize)
    await fd.read(cd, 0, cdSize, cdOffset)
    const entries: ZipEntry[] = []
    let offset = 0
    for (let index = 0; index < totalEntries; index += 1) {
      if (cd.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
        throw new Error(`runtime archive central directory is corrupt at entry ${index}`)
      }
      const flags = cd.readUInt16LE(offset + 8)
      const method = cd.readUInt16LE(offset + 10)
      const compressedSize = cd.readUInt32LE(offset + 20)
      const uncompressedSize = cd.readUInt32LE(offset + 24)
      const nameLength = cd.readUInt16LE(offset + 28)
      const extraLength = cd.readUInt16LE(offset + 30)
      const commentLength = cd.readUInt16LE(offset + 32)
      const localOffset = cd.readUInt32LE(offset + 42)
      const name = cd.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
      offset += 46 + nameLength + extraLength + commentLength

      if ((flags & 0x1) !== 0) throw new Error(`runtime archive entry is encrypted: ${name}`)
      if (method !== 0 && method !== 8) throw new Error(`runtime archive entry uses unsupported method ${method}: ${name}`)
      if (name === '' || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/u.test(name) || name.split('/').includes('..')) {
        throw new Error(`runtime archive entry escapes the destination: ${name}`)
      }
      entries.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        dataOffset: localOffset + 30 + nameLength + extraLength,
      })
    }
    return entries
  } finally {
    await fd.close()
  }
}
