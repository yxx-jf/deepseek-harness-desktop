/**
 * Subprocess entry for testing parallel extraction; spawned by
 * parallel-extract.spec.ts and handy for manual verification.
 */

import { extractZipParallel } from '../../src/parallel-extract.ts'

const archive = process.argv[2]
const destination = process.argv[3]
if (archive === undefined || destination === undefined) {
  console.error('usage: parallel-extract-cli <archive> <destination>')
  process.exit(2)
}

try {
  await extractZipParallel(archive, destination)
  console.log('PARALLEL_EXTRACT_OK')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
