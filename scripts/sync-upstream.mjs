#!/usr/bin/env node
/**
 * Sync the official upstream into this desktop fork and rebuild.
 *
 * The desktop shell lives inside the official monorepo, so "track upstream"
 * means: fetch origin (the official repository), merge origin/master, then
 * reinstall and rebuild so the next desktop package is built from the latest
 * upstream. Run from the repository root:
 *
 *   pnpm run sync-upstream
 *
 * A merge conflict aborts loudly so you can resolve it by hand; nothing is
 * committed or pushed here.
 */
import { execSync } from 'node:child_process'

function run(command) {
  console.log(`\n$ ${command}`)
  execSync(command, { stdio: 'inherit' })
}

run('git fetch origin')

const [ahead, behind] = execSync('git rev-list --left-right --count origin/master...master', { encoding: 'utf8' })
  .trim()
  .split(/\s+/)
  .map(Number)
console.log(`local master is ${ahead} ahead, ${behind} behind origin/master`)

if (behind > 0) {
  run('git merge origin/master --no-edit')
} else {
  console.log('already up to date with origin/master')
}

run('pnpm install')
run('pnpm run build')

console.log('\nupstream sync complete.')
console.log('rebuild the desktop installer:  pnpm --filter @deepseek-ai/dsh-desktop run dist:win:fast')
console.log('publish the runtime archive:   pnpm --filter @deepseek-ai/dsh-desktop run publish:runtime --url <base> --write-config')
