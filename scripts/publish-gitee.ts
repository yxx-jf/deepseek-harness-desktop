/**
 * Publish release artifacts to Gitee (download-mirror / thin-shell host).
 *
 * The desktop's installers and runtime live on Gitee because Gitee's release
 * attachments are fast and public (no login) in mainland China. Gitee has no
 * `releases/latest` alias, so every publish refreshes a FIXED `stable` tag:
 *   - delete the existing `stable` release (removes old attachments),
 *   - recreate it on the same tag (Gitee requires `body`; tag persists),
 *   - upload the app installers (exe + blockmap + latest.yml) and the
 *     thin-shell runtime (dsh-runtime-*.zip + runtime-manifest.json).
 * electron-updater's generic feed and the runtime bootstrap both point at
 *   https://gitee.com/<owner>/<repo>/releases/download/stable/
 *
 * Requires GITEE_TOKEN in .env (personal token with `projects` scope).
 *
 * Usage:
 *   node --import tsx scripts/publish-gitee.ts [--tag stable] [--repo owner/repo]
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const DEFAULT_REPO = 'yixiao-xiao/dsh-pc-release'
const DEFAULT_TAG = 'stable'

interface PublishOptions {
  readonly repo: string
  readonly tag: string
  readonly token: string
  readonly files: string[]
}

function parseArgs(argv: readonly string[]): Omit<PublishOptions, 'files'> {
  let repo = process.env.DSH_GITEE_REPO ?? DEFAULT_REPO
  let tag = process.env.DSH_GITEE_TAG ?? DEFAULT_TAG
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--tag') { tag = argv[i + 1] ?? tag; i += 1 }
    else if (arg === '--repo') { repo = argv[i + 1] ?? repo; i += 1 }
    else throw new Error(`publish-gitee: unknown argument ${arg}`)
  }
  return { repo, tag, token: getGiteeToken() }
}

function getGiteeToken(): string {
  const envPath = join(ROOT, '.env')
  if (existsSync(envPath)) {
    const text = readFileSync(envPath, 'utf8')
    const match = text.match(/^GITEE_TOKEN=(.+)$/m)
    if (match !== null) return match[1].trim()
  }
  const token = process.env.GITEE_TOKEN
  if (token !== undefined && token.length > 0) return token
  throw new Error(
    'GITEE_TOKEN not found. Add it to .env (gitee.com → 设置 → 私人令牌, scope: projects).',
  )
}

/** Run curl with args, returning (status, body). */
function curl(args: string[]): Promise<{ status: string; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    const child = spawn('curl.exe', [...args, '-s', '-w', '\n%{http_code}'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`curl exited ${String(code)}`))
      else {
        const text = Buffer.concat(chunks).toString('utf8')
        const newline = text.lastIndexOf('\n')
        const body = newline >= 0 ? text.slice(0, newline) : text
        const status = newline >= 0 ? text.slice(newline + 1).trim() : ''
        resolvePromise({ status, body })
      }
    })
  })
}

function apiBase(repo: string): string {
  return `https://gitee.com/api/v5/repos/${repo}`
}

/** Find the release id for a tag, or undefined. */
async function findReleaseId(repo: string, token: string, tag: string): Promise<number | undefined> {
  const { status, body } = await curl([`${apiBase(repo)}/releases/tags/${tag}?access_token=${token}`])
  if (status === '200') {
    try { return Number(JSON.parse(body).id) } catch { return undefined }
  }
  return undefined
}

/** Delete a release so attachments are fully cleared (Gitee allows dup names otherwise). */
async function deleteRelease(repo: string, token: string, releaseId: number): Promise<void> {
  await curl(['-X', 'DELETE', `${apiBase(repo)}/releases/${releaseId}?access_token=${token}`])
}

/** Create a release on an existing tag. Gitee requires `body`. */
async function createRelease(repo: string, token: string, tag: string): Promise<number> {
  const { status, body } = await curl([
    '-X', 'POST',
    '--data-urlencode', `access_token=${token}`,
    '--data-urlencode', `tag_name=${tag}`,
    '--data-urlencode', 'target_commitish=master',
    '--data-urlencode', 'name=DeepSeek Harness (stable)',
    '--data-urlencode', 'body=DeepSeek Harness desktop stable channel — installers and runtime. Auto-refreshed on every publish.',
    '--data-urlencode', 'prerelease=false',
    `${apiBase(repo)}/releases`,
  ])
  if (status !== '201') throw new Error(`Gitee create release failed (${status}): ${body.slice(0, 300)}`)
  const id = Number(JSON.parse(body).id)
  console.log(`  ✅ release ${tag} created (#${id})`)
  return id
}

/** Upload one file as a release attachment (multipart). */
async function uploadAttachment(repo: string, token: string, releaseId: number, filePath: string): Promise<void> {
  const name = filePath.split(/[\\/]/).pop() as string
  const sizeMB = (existsSync(filePath) ? readFileSync(filePath).length / 1024 / 1024 : 0).toFixed(1)
  console.log(`  📤 ${name} (${sizeMB} MB)…`)
  const { status, body } = await curl([
    '-X', 'POST',
    '-H', 'Content-Type: multipart/form-data',
    '-F', `access_token=${token}`,
    '-F', `file=@${filePath}`,
    `${apiBase(repo)}/releases/${releaseId}/attach_files`,
  ])
  if (status !== '201') throw new Error(`Gitee upload ${name} failed (${status}): ${body.slice(0, 300)}`)
  console.log(`  ✅ ${name} uploaded`)
}

/** Push (create or update) the stable tag pointing at the repo HEAD. */
async function ensureTag(repo: string, token: string, tag: string): Promise<void> {
  // Skip when the tag already exists (Gitee POST /tags rejects duplicates).
  const { status: listStatus, body: listBody } = await curl([`${apiBase(repo)}/tags?access_token=${token}`])
  if (listStatus === '200') {
    try {
      const tags = JSON.parse(listBody) as Array<{ name?: unknown }>
      if (tags.some(t => t.name === tag)) {
        console.log(`  ✅ tag ${tag} already exists`)
        return
      }
    } catch { /* fall through to create */ }
  }
  // Gitee's "create a repository tag" endpoint (POST /tags) accepts
  // `refs=HEAD`, verified live (HTTP 201).
  const { status, body } = await curl([
    '-X', 'POST',
    '--data-urlencode', `access_token=${token}`,
    '--data-urlencode', `tag_name=${tag}`,
    '--data-urlencode', 'refs=HEAD',
    '--data-urlencode', 'message=DeepSeek Harness stable channel',
    `${apiBase(repo)}/tags`,
  ])
  if (status !== '201' && status !== '200') {
    throw new Error(`Gitee create tag failed (${status}): ${body.slice(0, 300)}`)
  }
  console.log(`  ✅ tag ${tag} updated`)
}

async function main(): Promise<void> {
  const { repo, tag, token } = parseArgs(process.argv.slice(2))

  // Locate artifacts in dist/.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
  const version = pkg.version
  const exe = join(ROOT, 'dist', `DeepSeek-Harness-${version}-x64.exe`)
  const blockmap = join(ROOT, 'dist', `DeepSeek-Harness-${version}-x64.exe.blockmap`)
  const latestYml = join(ROOT, 'dist', 'latest.yml')
  const runtimeDir = join(ROOT, 'dist', 'runtime')
  const runtimeManifest = join(runtimeDir, 'runtime-manifest.json')

  const files: string[] = [exe, blockmap, latestYml]
  if (existsSync(runtimeManifest)) {
    const manifest = JSON.parse(readFileSync(runtimeManifest, 'utf8')) as { url?: string; parts?: Array<{ name?: string }> }
    if (typeof manifest.url === 'string') {
      const zipName = manifest.url.split('/').pop()
      if (zipName !== undefined) {
        const zip = join(runtimeDir, zipName)
        if (existsSync(zip)) files.push(zip, runtimeManifest)
        else console.warn(`  ⚠️ runtime zip missing: ${zipName}`)
      }
    }
    // Parallel download parts (dsh-runtime-*.zip.part0..N) from the manifest.
    for (const part of manifest.parts ?? []) {
      if (typeof part.name === 'string' && part.name.length > 0) {
        const partPath = join(runtimeDir, part.name)
        if (existsSync(partPath)) files.push(partPath)
        else console.warn(`  ⚠️ runtime part missing: ${part.name}`)
      }
    }
  }

  const missing = files.filter(f => !existsSync(f))
  if (missing.length > 0) {
    throw new Error(`publish-gitee: missing artifacts:\n  ${missing.join('\n  ')}\nRun publish:runtime and dist:thin first.`)
  }

  console.log(`\n🚀 Publishing ${repo} @ ${tag} (v${version})\n`)

  await ensureTag(repo, token, tag)
  const oldId = await findReleaseId(repo, token, tag)
  if (oldId !== undefined) {
    console.log(`  删除旧 stable release #${oldId}…`)
    await deleteRelease(repo, token, oldId)
  }
  const releaseId = await createRelease(repo, token, tag)
  for (const file of files) {
    await uploadAttachment(repo, token, releaseId, file)
  }

  console.log(`\n🎉 发布完成`)
  console.log(`   安装包: https://gitee.com/${repo}/releases/download/${tag}/`)
  if (existsSync(runtimeManifest)) {
    console.log(`   运行时: ${JSON.parse(readFileSync(runtimeManifest, 'utf8')).url}`)
  }
}

main().catch((error) => {
  console.error(`\n❌ Gitee 发布失败: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
