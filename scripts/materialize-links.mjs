#!/usr/bin/env node
/**
 * Materialize every symlink under runtime-host/node_modules into real bytes,
 * in a single traversal (no repeated root scans), then print the count.
 */
import { lstatSync, readdirSync, realpathSync, rmSync, cpSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'

const staging = 'F:/Desktop/web/my case/deepseek-harness-desktop/runtime-host'
const nodeModules = join(staging, 'node_modules')
if (!existsSync(nodeModules)) throw new Error(`missing: ${nodeModules}`)

const links = []
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      links.push(path)
    } else if (stat.isDirectory()) {
      collect(path)
    }
  }
}
console.log('scanning symlinks...')
collect(nodeModules)
console.log(`found ${links.length} symlinks`)

let materialized = 0
for (const link of links) {
  const segments = link.slice(nodeModules.length + 1).split(sep)
  const bin = segments.lastIndexOf('.bin')
  if (bin >= 0) {
    // Drop dangling .bin shims; real scripts live next to their packages.
    rmSync(join(nodeModules, ...segments.slice(0, bin + 1)), { recursive: true, force: true })
    continue
  }
  const source = realpathSync(link)
  rmSync(link, { recursive: true, force: true })
  cpSync(source, link, {
    recursive: true,
    dereference: true,
    filter: (path) => path !== join(source, 'node_modules') && !path.startsWith(join(source, 'node_modules') + sep),
  })
  materialized += 1
}
console.log(`materialized ${materialized} symlinks (skipped ${links.length - materialized} .bin dirs)`)