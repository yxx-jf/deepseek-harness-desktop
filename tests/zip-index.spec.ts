/** Unit tests for ZIP central-directory parsing. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { parseZipIndex } from '../src/zip-index.ts'

let work: string

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'dsh-zipidx-'))
})

afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

async function writeZip(name: string, files: Record<string, Uint8Array>): Promise<string> {
  const path = join(work, name)
  await writeFile(path, Buffer.from(zipSync(files)))
  return path
}

describe('parseZipIndex', () => {
  it('parses names, methods, sizes and data offsets in archive order', async () => {
    const small = strToU8('export const a = 1;')
    const archive = await writeZip('tree.zip', {
      'package.json': strToU8('{"name":"x"}'),
      'node_modules/a/index.js': small,
      'node_modules/a/deep/file.bin': new Uint8Array([1, 2, 3, 4]),
    })
    const entries = await parseZipIndex(archive)
    expect(entries.map(entry => entry.name)).toEqual([
      'package.json',
      'node_modules/a/index.js',
      'node_modules/a/deep/file.bin',
    ])
    for (const entry of entries) expect(entry.method).toBe(8)
    expect(entries[1]?.uncompressedSize).toBe(small.length)
    for (const entry of entries) {
      expect(entry.compressedSize).toBeGreaterThan(0)
      expect(entry.dataOffset).toBeGreaterThan(0)
    }
    // zipSync emits entries in insertion order, so data offsets are non-decreasing.
    const offsets = entries.map(entry => entry.dataOffset)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
  })

  it('rejects an entry that escapes the destination', async () => {
    const archive = await writeZip('evil.zip', { '../evil.txt': strToU8('pwned') })
    await expect(parseZipIndex(archive)).rejects.toThrow(/escapes the destination/)
  })

  it('rejects an entry with an absolute path', async () => {
    const archive = await writeZip('abs.zip', { 'C:/Windows/system32/x.txt': strToU8('x') })
    await expect(parseZipIndex(archive)).rejects.toThrow(/escapes the destination/)
  })

  it('rejects data without an end-of-central-directory', async () => {
    const archive = join(work, 'garbage.zip')
    await writeFile(archive, Buffer.from('this is definitely not a zip archive'))
    await expect(parseZipIndex(archive)).rejects.toThrow(/no end-of-central-directory/)
  })

  it('rejects an empty file', async () => {
    const archive = join(work, 'empty.zip')
    await writeFile(archive, Buffer.alloc(0))
    await expect(parseZipIndex(archive)).rejects.toThrow(/too small/)
  })
})
