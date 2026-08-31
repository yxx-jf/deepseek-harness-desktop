/**
 * Regenerate runtime/package.json from the current workspace.
 *
 * The packaged desktop Host needs every product workspace package resolvable
 * from its flat node_modules, because Cordis resolves bare plugin names from
 * node_modules. Rather than hand-maintaining that list across upstream
 * updates, derive it from the workspace: every `@deepseek-ai/*` package except
 * the explicitly excluded non-product groups below.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { globSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_EXCLUDED_PACKAGES } from './runtime-excludes.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = existsSync(join(desktopRoot, 'upstream', 'package.json'))
  ? join(desktopRoot, 'upstream')
  : resolve(desktopRoot, '../..')
const runtimeManifestPath = join(desktopRoot, 'runtime', 'package.json')

async function main(): Promise<void> {
  const paths = globSync([
    'packages/*/*/package.json',
    'apps/*/package.json',
    'vendor/*/package.json',
    'native/landlock-run/packages/*/package.json',
  ], { cwd: repositoryRoot }).sort()
  const names: string[] = []
  for (const relative of paths) {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, relative), 'utf8')) as { name?: string }
    if (manifest.name !== undefined && !RUNTIME_EXCLUDED_PACKAGES.has(manifest.name)) names.push(manifest.name)
  }
  names.sort()
  const dependencies: Record<string, string> = {}
  for (const name of names) dependencies[name] = 'workspace:^'
  // The official plugin market (dshmarket) is deliberately NOT listed here:
  // it is an external npm package that lives outside the upstream workspace
  // lockfile, so pnpm deploy would not install it and restoreLegacyHoists
  // would fail. stage-runtime.ts copies it into the runtime closure directly.
  const manifest = {
    name: '@deepseek-ai/dsh-desktop-runtime',
    description: 'Dependency-only deploy root for the packaged desktop Host',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies,
  }
  await mkdir(dirname(runtimeManifestPath), { recursive: true })
  await writeFile(runtimeManifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  console.log(`desktop runtime manifest: ${names.length} workspace packages -> ${runtimeManifestPath}`)
}

await main()
