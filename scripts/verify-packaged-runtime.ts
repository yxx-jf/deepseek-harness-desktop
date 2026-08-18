/** Reject a packaged desktop shell that has neither a bundled nor a configured runtime. */

import { readFileSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { AfterPackContext } from 'electron-builder'

const REQUIRED_HOST_FILES = [
  ['@deepseek-ai', 'dsh', 'lib', 'bin.js'],
  ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'],
] as const

/**
 * A packaged shell must be able to start its Host: either a bundled runtime
 * under resources/host or a remote manifest URL in desktop-resources. The
 * two-step installer ships the remote config and omits the bundled runtime;
 * the bundled layout is still verified when present.
 * @param context - Electron Builder's completed application directory.
 * @returns A promise that rejects when the shell has no usable runtime.
 */
export async function afterPack(context: AfterPackContext): Promise<void> {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  const bundledHost = join(resources, 'host', 'node_modules')
  try {
    await access(bundledHost)
  } catch {
    // No bundled runtime: the remote path must be configured so first launch
    // can download one. Rejecting here keeps a broken installer from shipping.
    const configPath = join(resources, 'desktop-resources', 'runtime-config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { manifestUrl?: unknown }
    if (typeof config.manifestUrl !== 'string' || config.manifestUrl.length === 0) {
      throw new Error(
        'desktop shell has no bundled runtime and no remote manifest URL; ' +
        'run publish:runtime --write-config before packaging (or bundle resources/host)',
      )
    }
    return
  }
  for (const segments of REQUIRED_HOST_FILES) {
    await access(join(bundledHost, ...segments))
  }
}

export default afterPack
