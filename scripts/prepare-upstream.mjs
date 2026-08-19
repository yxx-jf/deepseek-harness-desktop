#!/usr/bin/env node
/**
 * Prepare the upstream repository for development or packaging.
 *
 * 1. Sync upstream (clone if missing, pull if exists)
 * 2. Install upstream dependencies
 * 3. Build upstream artifacts (CLI, client packages, web frontend)
 *
 * Designed to run as a pre-step before dev or dist commands.
 * Skip with --skip-upstream if the upstream is already prepared.
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_DIR = resolve(ROOT, 'upstream')
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
const UPSTREAM_PKG = resolve(UPSTREAM_DIR, 'package.json')

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

async function syncUpstream() {
  console.log('\n=== 1/4 同步上游仓库 ===')
  if (!existsSync(UPSTREAM_DIR)) {
    console.log('  克隆 upstream...')
    run(`git clone --depth 1 ${UPSTREAM_URL} "${UPSTREAM_DIR}"`)
  } else {
    console.log('  更新 upstream...')
    run('git fetch origin --depth 1', { cwd: UPSTREAM_DIR })
    run('git reset --hard origin/master', { cwd: UPSTREAM_DIR })
  }
}

async function installUpstream() {
  console.log('\n=== 2/4 安装上游依赖 ===')
  run('pnpm install --frozen-lockfile --ignore-scripts', { cwd: UPSTREAM_DIR })
}

async function buildUpstream() {
  console.log('\n=== 3/4 构建上游 CLI 与客户端包 ===')
  run('pnpm run build:lib:host', { cwd: UPSTREAM_DIR })
  run('pnpm run build:lib:client', { cwd: UPSTREAM_DIR })
  console.log('\n=== 4/4 构建 Web 前端 ===')
  run('pnpm run build:web', { cwd: UPSTREAM_DIR })
  console.log('\n✔ 上游准备完成')
}

async function main() {
  const skip = process.argv.includes('--skip-upstream')
  if (skip && existsSync(UPSTREAM_PKG)) {
    console.log('跳过上游同步（--skip-upstream）')
    return
  }
  await syncUpstream()
  await installUpstream()
  await buildUpstream()
}

main().catch((err) => {
  console.error('\n❌ 上游准备失败:', err.message)
  process.exit(1)
})