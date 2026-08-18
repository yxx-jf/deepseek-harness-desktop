/**
 * Build script for the DeepSeek Harness Desktop installer.
 *
 * Structure:
 *   .                     ← main project (desktop Electron shell, root)
 *   upstream/             ← official deepseek-ai/deepseek-harness (synced separately)
 *
 * The desktop shell is self-contained (deps in package.json).
 * The Host runtime is downloaded at first launch from a remote manifest,
 * so the upstream packages are not needed for the shell build.
 *
 * Usage:
 *   node scripts/build-desktop.mjs          # install + build
 *   node scripts/build-desktop.mjs --sync   # sync upstream + install + build
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_DIR = resolve(ROOT, 'upstream')
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
const ELECTRON_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

function run(label, cmd, opts = {}) {
  console.log(`\n\u25b6 ${label}`)
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts })
}

function buildEnv() {
  return {
    ...process.env,
    ELECTRON_MIRROR,
    ELECTRON_BUILDER_BINARIES_MIRROR,
    NODE_OPTIONS: process.env.NODE_OPTIONS || '--use-system-ca',
  }
}

async function main() {
  const args = process.argv.slice(2)
  const shouldSync = args.includes('--sync')

  // \u2500\u2500 Step 1 (optional): sync official upstream \u2500\u2500\u2500
  if (shouldSync) {
    console.log(`\n\u25b6 Syncing official upstream into ${UPSTREAM_DIR}...`)
    if (!existsSync(UPSTREAM_DIR)) {
      run('Clone official repo', `git clone --depth 1 ${UPSTREAM_URL} "${UPSTREAM_DIR}"`)
    } else {
      run('Fetch official upstream', 'git fetch origin --depth 1', { cwd: UPSTREAM_DIR })
      run('Merge upstream', 'git merge origin/master', { cwd: UPSTREAM_DIR })
    }
    console.log('  \u2713 Upstream synced')
  } else {
    console.log('\n  (skip upstream sync, use --sync to update)')
  }

  // \u2500\u2500 Step 2: ensure electron binary is installed \u2500\u2500
  const electronDist = resolve(ROOT, 'node_modules/electron/dist')
  if (!existsSync(electronDist)) {
    console.log('\n\u25b6 Installing electron binary...')
    run('Install electron binary', 'node node_modules/electron/install.js', { env: buildEnv() })
  } else {
    console.log('\n  (electron binary already installed)')
  }

  // \u2500\u2500 Step 3: install dependencies \u2500\u2500\u2500\u2500\u2500
  run('Install dependencies', 'pnpm install', { env: buildEnv() })

  // \u2500\u2500 Step 4: build the desktop installer \u2500\u2500\u2500\u2500
  const distDir = resolve(ROOT, 'dist')
  if (existsSync(distDir)) {
    console.log('\n  (cleaning previous dist output)')
    execSync(`rm -rf "${distDir}"`, { cwd: ROOT })
  }

  run('Build and package desktop (NSIS installer)',
    'pnpm --filter @deepseek-ai/dsh-desktop run dist:win:fast',
    { env: buildEnv() },
  )

  // \u2500\u2500 Done \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const output = execSync(
    'dir /b /o-d apps\\desktop\\dist\\DeepSeek-Harness-*.exe 2>nul',
    { cwd: ROOT, encoding: 'utf8' },
  ).trim().split('\n')[0]

  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550')
  console.log('  Build complete!')
  if (output) {
    console.log(`  Installer: dist/${output}`)
    console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550')
    console.log('\n  To install, run the NSIS installer.')
    console.log('  First launch will download the Host runtime.')
  } else {
    console.log('  (installer not found, check build output)')
  }
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550')
}

main().catch((err) => {
  console.error('\n\u274c Build failed:', err.message)
  process.exit(1)
})