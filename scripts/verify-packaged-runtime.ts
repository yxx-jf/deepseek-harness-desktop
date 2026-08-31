/** Reject a packaged desktop shell that has neither a bundled nor a configured runtime. */

import { readFileSync, cpSync, existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AfterPackContext } from 'electron-builder'

const DESKTOP_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const RUNTIME_HOST_DIR = resolve(DESKTOP_ROOT, 'runtime-host')

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
  const hostDir = join(resources, 'host')
  const bundledHost = join(hostDir, 'node_modules')

  // Thin-shell mode: a runtime-config.json shipped into desktop-resources
  // points at a remote runtime manifest (published to Gitee/GitHub). Skip
  // bundling runtime-host entirely — the runtime ZIP is created by
  // publish-runtime.ts and already carries every desktop patch, so a thin
  // installer needs no embedded Host and no afterPack patching.
  const remoteConfigPath = join(resources, 'desktop-resources', 'runtime-config.json')
  if (existsSync(remoteConfigPath)) {
    const remoteConfig = JSON.parse(readFileSync(remoteConfigPath, 'utf8')) as { manifestUrl?: unknown }
    if (typeof remoteConfig.manifestUrl === 'string' && remoteConfig.manifestUrl.length > 0) {
      console.log(`afterPack: thin shell — runtime served from ${remoteConfig.manifestUrl}`)
      return
    }
  }

  // Copy the staged runtime into the packaged app when it isn't bundled yet.
  // electron-builder's extraResources filters out node_modules, so we do the
  // copy here in the afterPack hook where we control the exact files.
  if (await access(bundledHost).then(() => true).catch(() => false)) {
    // Already bundled; verify expected files.
    for (const segments of REQUIRED_HOST_FILES) {
      await access(join(bundledHost, ...segments))
    }
    return
  }

  // No bundled runtime yet — copy from the staged source.
  if (!existsSync(RUNTIME_HOST_DIR)) {
    // Fall back to remote config.
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

  // Apply every desktop-specific runtime patch (native picker with forced
  // browse backend, brand label + locale, native path opener) so the bundled
  // Host stays identical to the remote runtime ZIP published by
  // publish-runtime.ts — thin-shell installs must not run an unpatched Host.
  const { applyRuntimePatches } = await import('./runtime-patches.mjs')
  await applyRuntimePatches(RUNTIME_HOST_DIR)

  console.log(`afterPack: copying runtime-host to ${hostDir}`)
  cpSync(RUNTIME_HOST_DIR, hostDir, { recursive: true, dereference: true })
  for (const segments of REQUIRED_HOST_FILES) {
    await access(join(bundledHost, ...segments))
  }
}

export default afterPack
