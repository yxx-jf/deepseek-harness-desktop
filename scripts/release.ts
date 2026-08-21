/**
 * One-command release: build shell, stage runtime, publish everything to GitHub Releases.
 *
 * Requires GH_TOKEN environment variable set to a GitHub Personal Access Token
 * with `repo` scope for the repository in build.publish (yxx-jf/deepseek-harness-desktop).
 *
 * Usage:
 *   $env:GH_TOKEN = "ghp_..."
 *   pnpm run release
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const TAG_PREFIX = 'v'
const REPO = 'yxx-jf/deepseek-harness-desktop'

/** Run a child process and inherit its stdio. */
function run(cmd: string, args: readonly string[], cwd?: string): Promise<void> {
  const fullCmd = `${cmd} ${args.join(' ')}`
  console.log(`  $ ${fullCmd}`)
  return new Promise<void>((accept, reject) => {
    const child = spawn(cmd, args, { cwd: cwd ?? ROOT, stdio: 'inherit', shell: true })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) accept()
      else reject(new Error(`Command failed (exit ${String(code)}): ${fullCmd}`))
    })
  })
}

/** Run a shell command and return stdout. */
function exec(cmd: string): Promise<string> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = []
    const child = spawn(cmd, { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) accept(Buffer.concat(chunks).toString().trim())
      else reject(new Error(`exec failed (exit ${String(code)}): ${cmd}`))
    })
  })
}

/** Run curl and return parsed JSON. */
async function curlJson(args: string[], method = 'GET', body?: string): Promise<any> {
  const token = await getGitHubToken()
  const cmd = `curl.exe -s -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github.v3+json" ${body ? `-X ${method} -d @-` : ''} ${args.join(' ')}`
  const result = await new Promise<string>((accept, reject) => {
    const chunks: Buffer[] = []
    const child = spawn(cmd, { cwd: ROOT, shell: true, stdio: ['pipe', 'pipe', 'inherit'] })
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) accept(Buffer.concat(chunks).toString().trim())
      else reject(new Error(`curl failed (exit ${String(code)})`))
    })
    if (body !== undefined) child.stdin.end(body)
  })
  return JSON.parse(result)
}

function getGitHubToken(): string {
  // Try .env file first, then environment variable
  const envPath = join(ROOT, '.env')
  if (existsSync(envPath)) {
    const text = readFileSync(envPath, 'utf8')
    const match = text.match(/^GH_TOKEN=(.+)$/m)
    if (match !== null) return match[1].trim()
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (token !== undefined) return token
  throw new Error(
    'GH_TOKEN not found. Create a .env file from the example:\n' +
    '  copy .env.example .env\n' +
    'Then edit .env and paste your token.\n' +
    'Get a token at: https://github.com/settings/tokens/new?scopes=repo&description=dsh-desktop-release'
  )
}

async function getOrCreateRelease(version: string, tag: string): Promise<number> {
  console.log(`\n🔍 查找 Release: ${tag}...`)
  try {
    const release = await curlJson([`https://api.github.com/repos/${REPO}/releases/tags/${tag}`])
    console.log(`  找到现有 Release #${release.id}`)
    return release.id as number
  } catch {
    // Release doesn't exist, create one
  }

  console.log(`  创建新 Release: ${tag}...`)
  const body = JSON.stringify({ tag_name: tag, name: tag, body: `DeepSeek Harness Desktop ${version}` })
  const release = await curlJson([`https://api.github.com/repos/${REPO}/releases`], 'POST', body)
  console.log(`  ✅ Release #${release.id} 创建成功`)
  return release.id as number
}

async function uploadAsset(token: string, releaseId: number, filePath: string): Promise<void> {
  const fileName = filePath.split(/[/\\]/).pop()!
  console.log(`  📤 上传: ${fileName}...`)

  // Delete existing asset with same name
  try {
    const assets = await curlJson([`https://api.github.com/repos/${REPO}/releases/${releaseId}/assets`])
    for (const asset of (assets as Array<{ id: number; name: string }>)) {
      if (asset.name === fileName) {
        console.log(`  删除旧资产: ${fileName}...`)
        await exec(`curl.exe -s -X DELETE -H "Authorization: Bearer ${token}" -H "Accept: application/vnd.github.v3+json" "https://api.github.com/repos/${REPO}/releases/assets/${asset.id}"`)
        break
      }
    }
  } catch {
    // Ignore listing errors
  }

  // Upload using curl (native Windows TLS stack)
  const sizeMB = (existsSync(filePath) ? readFileSync(filePath).length / 1024 / 1024 : 0).toFixed(1)
  await exec(
    `curl.exe -s -X POST ` +
    `-H "Authorization: Bearer ${token}" ` +
    `-H "Content-Type: application/octet-stream" ` +
    `--data-binary "@${filePath}" ` +
    `"https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${fileName}"`
  )
  console.log(`  ✅ ${fileName} (${sizeMB} MB) 上传成功`)
}

async function main(): Promise<void> {
  const token = getGitHubToken()
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  const version = pkg.version
  const tag = `${TAG_PREFIX}${version}`

  console.log(`🚀 DeepSeek Harness Desktop v${version} 发布流程\n`)

  // Step 1: Build shell
  console.log('\n=== 1/4 构建壳层 ===')
  await run('pnpm', ['run', 'build:shell'])

  // Step 2: Stage runtime and generate publish artifacts
  console.log('\n=== 2/4 生成运行时产物 ===')
  const baseUrl = `https://github.com/${REPO}/releases/download/${tag}`
  await run('pnpm', ['run', 'publish:runtime', '--url', baseUrl, '--write-config'])

  // Step 3: Build installer with electron-builder
  console.log('\n=== 3/4 打包安装包 ===')
  await new Promise<void>((accept, reject) => {
    const cmd = `pnpm run build:shell && npx electron-builder --win nsis`
    console.log(`  $ ${cmd}`)
    const child = spawn(cmd, { cwd: ROOT, stdio: 'inherit', shell: true })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) accept()
      else reject(new Error(`打包失败 (exit ${String(code)})`))
    })
  })

  // Step 4: Upload all assets to GitHub Release
  console.log('\n=== 4/4 上传到 GitHub Release ===')
  const releaseId = await getOrCreateRelease(version, tag)

  // Collect all assets to upload
  const files: string[] = [
    join(ROOT, 'dist', `DeepSeek-Harness-${version}-x64.exe`),
    join(ROOT, 'dist', `DeepSeek-Harness-${version}-x64.exe.blockmap`),
    join(ROOT, 'dist', 'latest.yml'),
    join(ROOT, 'dist', 'runtime', 'runtime-manifest.json'),
  ]

  // Find runtime zip
  const runtimeDir = join(ROOT, 'dist', 'runtime')
  if (existsSync(runtimeDir)) {
    for (const file of await readdir(runtimeDir)) {
      if (file.startsWith('dsh-runtime-') && file.endsWith('.zip')) {
        files.push(join(runtimeDir, file))
        break
      }
    }
  }

  for (const filePath of files) {
    if (!existsSync(filePath)) {
      console.warn(`  ⚠️ 文件不存在，跳过: ${filePath}`)
      continue
    }
    await uploadAsset(token, releaseId, filePath)
  }

  console.log(`\n🎉 发布完成!`)
  console.log(`   查看: https://github.com/${REPO}/releases/tag/${tag}`)
}

main().catch((err) => {
  console.error(`\n❌ 发布失败: ${err.message}`)
  process.exit(1)
})