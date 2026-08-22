/**
 * Upload release assets to GitHub Releases for this repo.
 *
 * Usage:
 *   node scripts/upload-assets.cjs v0.1.0-rc.12 dist/DeepSeek-Harness-0.1.0-rc.12-x64.exe [dist/...blockmap]
 *
 * Reads GH_TOKEN from .env (preferred) or the environment, same as release.ts.
 * Existing assets with the same filename are deleted before upload.
 */

const fs = require('fs')
const cp = require('child_process')
const path = require('path')

const REPO = 'yxx-jf/deepseek-harness-desktop'
const ROOT = path.resolve(__dirname, '..')

function getGitHubToken() {
  const envPath = path.join(ROOT, '.env')
  if (fs.existsSync(envPath)) {
    const text = fs.readFileSync(envPath, 'utf8')
    const match = text.match(/^GH_TOKEN=(.+)$/m)
    if (match !== null) return match[1].trim()
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (token !== undefined) return token
  throw new Error('GH_TOKEN not found in .env or environment')
}

function curlJson(url, token, method = 'GET', body) {
  const args = ['-s', '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github.v3+json']
  if (method !== 'GET') args.push('-X', method)
  if (body !== undefined) args.push('-d', JSON.stringify(body))
  args.push(url)
  const out = cp.execFileSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return JSON.parse(out)
}

function curlRaw(url, token, method) {
  const args = ['-s', '-H', `Authorization: Bearer ${token}`, '-H', 'Accept: application/vnd.github.v3+json']
  if (method !== 'GET') args.push('-X', method)
  args.push(url)
  return cp.execFileSync('curl.exe', args, { encoding: 'utf8' })
}

async function main() {
  const tag = process.argv[2]
  const files = process.argv.slice(3)
  if (!tag || files.length === 0) {
    console.error('Usage: node scripts/upload-assets.cjs <tag> <file...>')
    process.exit(1)
  }
  for (const f of files) {
    if (!fs.existsSync(path.join(ROOT, f))) {
      console.error(`File not found: ${f}`)
      process.exit(1)
    }
  }

  const token = getGitHubToken()

  // Resolve the release (must already exist).
  let release
  try {
    release = curlJson(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, token)
  } catch (error) {
    console.error(`Release ${tag} not found: ${error.message}`)
    process.exit(1)
  }
  console.log(`Release #${release.id} · ${release.tag_name} · ${release.name}`)

  // List existing assets and delete same-named ones.
  const assets = curlJson(`https://api.github.com/repos/${REPO}/releases/${release.id}/assets`, token)
  const names = new Set(files.map((f) => path.basename(f)))
  for (const asset of assets) {
    if (names.has(asset.name)) {
      console.log(`Deleting existing asset: ${asset.name}...`)
      curlRaw(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, token, 'DELETE')
    }
  }

  // Upload each file.
  for (const f of files) {
    const fileName = path.basename(f)
    const abs = path.join(ROOT, f)
    const sizeMB = (fs.statSync(abs).size / 1024 / 1024).toFixed(1)
    console.log(`Uploading ${fileName} (${sizeMB} MB)...`)
    const args = [
      '-s', '-X', 'POST',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Content-Type: application/octet-stream',
      '--data-binary', `@${abs}`,
      `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${fileName}`,
    ]
    cp.execFileSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })
    console.log(`  ✅ ${fileName} uploaded`)
  }
  console.log('\nAll assets uploaded.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})