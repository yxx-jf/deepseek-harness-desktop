/** Integration tests for the parallel extraction worker pool, run through a real subprocess. */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'

const CLI = fileURLToPath(new URL('./helpers/parallel-extract-cli.ts', import.meta.url))
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

let work: string

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'dsh-parallel-'))
})

afterEach(async () => {
  await rm(work, { recursive: true, force: true })
})

/** Run the parallel-extraction CLI in a fresh Node process under tsx. */
function runCli(archive: string, destination: string): Promise<string> {
  return new Promise((accept, decline) => {
    execFile(process.execPath, ['--import', 'tsx', CLI, archive, destination], { cwd: REPOSITORY_ROOT }, (error, stdout, stderr) => {
      if (error !== null) decline(new Error(stderr || error.message))
      else accept(stdout)
    })
  })
}

describe('extractZipParallel', () => {
  it('extracts a nested archive byte-identically through the worker pool', async () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < 200; i += 1) files[`pkg/file-${i}.js`] = strToU8(`content ${i} `.repeat(10))
    const big = new Uint8Array(2_000_000)
    for (let i = 0; i < big.length; i += 997) big[i] = i % 251
    files['pkg/big.bin'] = big
    const archive = join(work, 'tree.zip')
    await writeFile(archive, Buffer.from(zipSync(files)))
    const destination = join(work, 'out')

    await expect(runCli(archive, destination)).resolves.toContain('PARALLEL_EXTRACT_OK')

    for (let i = 0; i < 200; i += 1) {
      const expected = strToU8(`content ${i} `.repeat(10))
      const actual = await readFile(join(destination, `pkg/file-${i}.js`))
      expect(Buffer.compare(actual, Buffer.from(expected))).toBe(0)
    }
    const bigActual = await readFile(join(destination, 'pkg/big.bin'))
    expect(Buffer.compare(bigActual, Buffer.from(big))).toBe(0)
  })

  it('rejects a corrupt archive through the worker pool', async () => {
    const archive = join(work, 'bad.zip')
    await writeFile(archive, Buffer.from('not a zip archive at all'))
    await expect(runCli(archive, join(work, 'out'))).rejects.toThrow()
  })
})
