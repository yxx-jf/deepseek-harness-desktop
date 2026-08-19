/**
 * Sync the official upstream repository into upstream/.
 *
 * This script clones or updates the official deepseek-ai/deepseek-harness
 * repository inside the desktop project, so the official packages can be
 * referenced for runtime publishing or development.
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_DIR = resolve(ROOT, 'upstream')
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

async function main() {
  console.log('▶ Syncing official upstream...')

  if (!existsSync(UPSTREAM_DIR)) {
    // Clone the official repo
    console.log(`  Cloning ${UPSTREAM_URL} into ${UPSTREAM_DIR}...`)
    run(`git clone --depth 1 ${UPSTREAM_URL} "${UPSTREAM_DIR}"`)
    console.log('  ✓ Upstream cloned successfully')
  } else {
    // Update existing clone
    console.log('  Fetching latest upstream...')
    run('git fetch origin --depth 1', { cwd: UPSTREAM_DIR })
    run('git merge origin/master', { cwd: UPSTREAM_DIR })
    console.log('  ✓ Upstream updated successfully')
  }

  console.log('\n══════════════════════════════════════════')
  console.log(`  Upstream location: ${UPSTREAM_DIR}`)
  console.log('  Use this to reference official packages')
  console.log('  for runtime publishing or development.')
  console.log('══════════════════════════════════════════')
}

main().catch((err) => {
  console.error('\n❌ Sync failed:', err.message)
  process.exit(1)
})