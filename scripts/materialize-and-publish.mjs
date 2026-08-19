#!/usr/bin/env node
/**
 * One-off: materialize symlinks in the deployed runtime-host tree, then
 * package it into a ZIP + runtime-manifest.json for the desktop Host.
 *
 * Usage:
 *   node --import tsx scripts/materialize-and-publish.mjs --url <baseUrl>
 *
 * Mirrors the materializeLinks/zip logic from stage-runtime.ts / publish-runtime.ts
 * so the published archive is self-contained (no symlinks into a local store).
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, realpathSync, writeFileSync, cpSync } from 'node:fs'
import { cp, lstat, mkdir, realpath, readdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { zipSync } from 'fflate'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staging = join(desktopRoot, 'runtime-host')
const hostEntry = join(staging, 'node_modules/@deepseek-ai/dsh/lib/bin.js')

/** Collect all symlink paths under root in one DFS pass (O(n) not O(n²)). */
async function collectSymlinks(root) {
  const links = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        links.push(path)
      } else if (metadata.isDirectory()) {
        pending.push(path)
      }
    }
  }
  return links
}

async function materializeLinks() {
  const nodeModules = join(staging, 'node_modules')
  const allLinks = await collectSymlinks(nodeModules)
  let count = 0
  for (const link of allLinks) {
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const bin = segments.lastIndexOf('.bin')
    if (bin >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, bin + 1)), { recursive: true, force: true })
      continue
    }
    const source = await realpath(link)
    await rm(link, { recursive: true, force: true })
    await cp(source, link, {
      recursive: true,
      dereference: true,
      filter: path => path !== join(source, 'node_modules') && !path.startsWith(join(source, 'node_modules') + sep),
    })
    count++
  }
  return count
}

async function walkFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return files
}

const ZIP_MTIME = new Date('2020-01-01T00:00:00Z')

async function createRuntimeArchive(sourceRoot, outFile) {
  await mkdir(dirname(outFile), { recursive: true })
  const files = {}
  for (const file of (await walkFiles(sourceRoot)).sort()) {
    const name = relative(sourceRoot, file).split(sep).join('/')
    files[name] = await readFile(file)
  }
  const archive = zipSync(files, { level: 9, mtime: ZIP_MTIME })
  await writeFile(outFile, archive)
  const hash = createHash('sha256')
  hash.update(archive)
  return { sha256: hash.digest('hex'), size: archive.byteLength }
}

async function main() {
  const args = process.argv.slice(2)
  let baseUrl = process.env.DSH_RUNTIME_PUBLISH_URL
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--url') { baseUrl = args[i + 1]; i += 1 }
    else throw new Error(`unknown argument ${args[i]}`)
  }
  if (!baseUrl) throw new Error('missing base URL (--url or DSH_RUNTIME_PUBLISH_URL)')
  baseUrl = baseUrl.replace(/\/+$/, '')

  if (!existsSync(hostEntry)) throw new Error(`staged Host entry is missing: ${hostEntry}`)

  console.log('materializing symlinks...')
  const links = await materializeLinks()
  console.log(`  replaced ${links} symlinks`)

  const fsRead = await import('node:fs')
  const pkg = JSON.parse((await readFile(join(desktopRoot, 'package.json'))).toString())
  const appVersion = pkg.version ?? '0.0.0'
  const archiveName = `dsh-runtime-${appVersion}.zip`
  const outDir = join(desktopRoot, 'dist', 'runtime')
  const archivePath = join(outDir, archiveName)
  console.log('creating archive...')
  const { sha256, size } = await createRuntimeArchive(staging, archivePath)
  const manifest = {
    version: appVersion,
    url: `${baseUrl}/${archiveName}`,
    sha256,
    size,
  }
  await writeFile(join(outDir, 'runtime-manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  console.log(`publish-runtime: ${archivePath} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256})`)
  console.log(`publish-runtime: manifest ${join(outDir, 'runtime-manifest.json')} -> ${manifest.url}`)
}

main().catch((error) => { console.error(error); process.exit(1) })