/** Reject a packaged desktop shell that has neither a bundled nor a configured runtime. */

import { readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs'
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

  // Patch the native picker first (worker IPC stdout fallback for Electron's node mode).
  const { patchNativePicker } = await import('./patch-native-picker.mjs')
  patchNativePicker(RUNTIME_HOST_DIR)

  // Patch the UI brand label from "DSH Local Build" / any prior residue to
  // the official product name "DeepSeek Harness".
  for (const file of ['dsh-client-ui-sidebar/lib/client.js', 'dsh-client-ui-renderer/lib/client.js']) {
    const p = join(RUNTIME_HOST_DIR, 'node_modules', '@deepseek-ai', file)
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8')
      // Handle both the pristine fallback and a previously applied lower-case
      // variant so the label always converges on the correct casing.
      let patched = text.replaceAll('DSH Local Build', 'DeepSeek Harness')
      patched = patched.replaceAll('deepseek harness', 'DeepSeek Harness')
      if (patched !== text) {
        writeFileSync(p, patched)
        console.log(`afterPack: patched brand label in ${file}`)
      }
    }
  }

  // Patch the native path opener so that .yaml/.yml/.json files (which
  // commonly have no file association on Windows) are opened with Notepad,
  // launched fire-and-forget (Start-Process) so the openDocument request does
  // not hang on a long-lived GUI process.
  const openerPath = join(RUNTIME_HOST_DIR, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'types', 'native-path-opener.js')
  if (existsSync(openerPath)) {
    const text = readFileSync(openerPath, 'utf8')
    // If the patch is absent (both the pristine Invoke-Item form and any
    // intermediate forms lack the final Start-Process variant), rewrite the
    // openWindowsPath function block wholesale.
    const marker = 'Start-Process -FilePath notepad.exe'
    if (!text.includes(marker)) {
      // (Pristine) function body without the extension special-case.
      const pristineFn = 'async function openWindowsPath(path, signal, run) {\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}'
      // (Intermediate) blocking notepad spawn.
      const blockingFn = 'async function openWindowsPath(path, signal, run) {\n    const ext = path.split(\'.\').pop().toLowerCase();\n    if (ext === \'yaml\' || ext === \'yml\' || ext === \'json\') {\n        await run(\'notepad.exe\', [path], signal);\n        return;\n    }\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}'
      const finalFn = 'async function openWindowsPath(path, signal, run) {\n    const ext = path.split(\'.\').pop().toLowerCase();\n    if (ext === \'yaml\' || ext === \'yml\' || ext === \'json\') {\n        // Fire-and-forget: the editor is a long-lived GUI process; waiting on\n        // it would hang the openDocument request until the user closes it.\n        await run(\'powershell.exe\', [\n            \'-NoProfile\',\n            \'-Command\',\n            \`Start-Process -FilePath notepad.exe -ArgumentList \${powershellLiteral(path)}\`,\n        ], signal);\n        return;\n    }\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}'
      const oldBody = text.includes(blockingFn) ? blockingFn : (text.includes(pristineFn) ? pristineFn : undefined)
      if (oldBody !== undefined) {
        writeFileSync(openerPath, text.replace(oldBody, finalFn))
        console.log('afterPack: patched native-path-opener for text file types')
      } else {
        console.log('afterPack: native-path-opener openWindowsPath signature mismatch (skipped)')
      }
    }
  }

  console.log(`afterPack: copying runtime-host to ${hostDir}`)
  cpSync(RUNTIME_HOST_DIR, hostDir, { recursive: true, dereference: true })
  for (const segments of REQUIRED_HOST_FILES) {
    await access(join(bundledHost, ...segments))
  }
}

export default afterPack
