#!/usr/bin/env node
/**
 * Apply every desktop-specific runtime patch to a runtime root (runtime-host
 * or a staged clone of it).
 *
 * WHY SHARED: a full installer applies the patches in the afterPack hook
 * right before copying runtime-host into resources/host, but the thin-shell
 * (remote runtime) build ships the runtime as a prebuilt ZIP published to a
 * download mirror (GitHub/Gitee). That ZIP is created by publish-runtime.ts
 * from the same runtime-host tree, so it must carry the identical patches or
 * remote installs would run an unpatched Host (broken native picker, wrong
 * brand label, invisible native path opener). Keeping one routine used by
 * both paths guarantees the artifacts match.
 *
 * All edits are idempotent and target compiled lib/ files only (what the
 * runtime actually loads); the upstream source tree is never touched.
 *
 * Usage:
 *   node scripts/runtime-patches.mjs [runtimeRoot]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_ROOT = resolve(process.argv[2] ?? join(DESKTOP_ROOT, 'runtime-host'))

/** Patch the native directory picker (worker IPC stdout fallback) and force the pure-Node browse backend. */
export async function patchNativePicker(runtimeRoot) {
  const { patchNativePicker, patchAutoPickerForceBrowse, patchWorkerDesktopBridge, patchMarketGitResolve, patchMarketNativeBuildGuidance, patchMarketRecommended } = await import('./patch-native-picker.mjs')
  patchNativePicker(runtimeRoot)
  // The packaged Host runs under ELECTRON_RUN_AS_NODE, where koffi (the FFI the
  // worker uses to drive the Win32 dialog) crashes with a NAPI ABI mismatch. A
  // patched worker branches to a temp-file bridge when the main process sets
  // DSH_DESKTOP_BRIDGE_PICKER=1 and answers with dialog.showOpenDialog.
  patchWorkerDesktopBridge(runtimeRoot)
  // The native Win32 backend's spawned Electron child is unreliable when
  // packaged, so force the pure-Node browse backend on every packaged boot.
  patchAutoPickerForceBrowse(runtimeRoot)
  // The packaged environment has no git, so let the market resolve GitHub
  // plugins over HTTP (commit-pinned) instead of pnpm's git ls-remote.
  patchMarketGitResolve(runtimeRoot)
  // Ordinary users get a clear "this needs a build toolchain" message instead
  // of a wall of gyp ERR! when a plugin needs node-gyp (desktop ships no
  // VS Build Tools), and officially verified plugins surface first.
  patchMarketNativeBuildGuidance(runtimeRoot)
  patchMarketRecommended(runtimeRoot)
}

/**
 * Apply every desktop-specific runtime patch to {@link runtimeRoot}.
 * @returns Number of distinct patches that ran (informational).
 */
export async function applyRuntimePatches(runtimeRoot = RUNTIME_ROOT) {
  let applied = 0

  // 1. Native directory picker — worker speaks IPC and/or stdout JSON lines.
  await patchNativePicker(runtimeRoot)
  applied += 1

  // 2. UI brand label: converge on the official product name in the sidebar
  //    and renderer bundles.
  for (const file of ['dsh-client-ui-sidebar/lib/client.js', 'dsh-client-ui-renderer/lib/client.js']) {
    const p = join(runtimeRoot, 'node_modules', '@deepseek-ai', file)
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8')
      let patched = text.replaceAll('DSH Local Build', 'DeepSeek Harness')
      patched = patched.replaceAll('deepseek harness', 'DeepSeek Harness')
      if (patched !== text) {
        writeFileSync(p, patched)
        console.log(`  + brand label in ${file}`)
        applied += 1
      }
    }
  }

  // 3. Newer sidebars read the brand title from the locale bundle's
  //    `brand.localBuild` key; pin it in every shipped dictionary.
  const localePath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-client-locale', 'lib', 'client.js')
  if (existsSync(localePath)) {
    const text = readFileSync(localePath, 'utf8')
    const patched = text
      .replaceAll('"brand.localBuild": "DSH 本地构建"', '"brand.localBuild": "DeepSeek Harness"')
      .replaceAll('"brand.localBuild": "DSH Local Build"', '"brand.localBuild": "DeepSeek Harness"')
      .replaceAll('"brand.localBuild": "deepseek harness"', '"brand.localBuild": "DeepSeek Harness"')
    if (patched !== text) {
      writeFileSync(localePath, patched)
      console.log('  + brand label in dsh-client-locale')
      applied += 1
    }
  }

  // 4. Native path opener: the Host (ELECTRON_RUN_AS_NODE child) cannot spawn
  //    visible GUI windows, so write the document path to a temp file the
  //    Electron main process polls and opens via shell.openPath().
  const openerPath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'types', 'native-path-opener.js')
  if (existsSync(openerPath)) {
    let text = readFileSync(openerPath, 'utf8')
    const marker = 'dsh-open-doc.txt'
    if (!text.includes(marker)) {
      const forms = [
        'async function openWindowsPath(path, signal, run) {\n    const ext = path.split(\'.\').pop().toLowerCase();\n    if (ext === \'yaml\' || ext === \'yml\' || ext === \'json\') {\n        await run(\'rundll32.exe\', [\n            \'shell32.dll,OpenAs_RunDLL\',\n            path,\n        ], signal);\n        return;\n    }\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}',
        'async function openWindowsPath(path, signal, run) {\n    const ext = path.split(\'.\').pop().toLowerCase();\n    if (ext === \'yaml\' || ext === \'yml\' || ext === \'json\') {\n        const { exec } = await import(\'node:child_process\');\n        exec(\'start "" "\' + path + \'"\', { windowsHide: true });\n        return;\n    }\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}',
        'async function openWindowsPath(path, signal, run) {\n    const ext = path.split(\'.\').pop().toLowerCase();\n    if (ext === \'yaml\' || ext === \'yml\' || ext === \'json\') {\n        const { spawn } = await import(\'node:child_process\');\n        const child = spawn(\'notepad.exe\', [path], { detached: true, stdio: \'ignore\' });\n        child.unref();\n        return;\n    }\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}',
        'async function openWindowsPath(path, signal, run) {\n    const ext = path.split(\'.\').pop().toLowerCase();\n    if (ext === \'yaml\' || ext === \'yml\' || ext === \'json\') {\n        await run(\'powershell.exe\', [\n            \'-NoProfile\',\n            \'-Command\',\n            \`Start-Process -FilePath notepad.exe -ArgumentList \${powershellLiteral(path)}\`,\n        ], signal);\n        return;\n    }\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}',
        'async function openWindowsPath(path, signal, run) {\n    const ext = path.split(\'.\').pop().toLowerCase();\n    if (ext === \'yaml\' || ext === \'yml\' || ext === \'json\') {\n        await run(\'notepad.exe\', [path], signal);\n        return;\n    }\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}',
        'async function openWindowsPath(path, signal, run) {\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}',
      ]
      const finalFn = 'async function openWindowsPath(path, signal, run) {\n    const ext = path.split(\'.\').pop().toLowerCase();\n    if (ext === \'yaml\' || ext === \'yml\' || ext === \'json\') {\n        // Write the path to a temp file that the Electron main process polls.\n        const { writeFileSync } = await import(\'node:fs\');\n        const { join } = await import(\'node:path\');\n        const tmp = process.env.TEMP || process.env.TMP || \'/tmp\';\n        writeFileSync(join(tmp, \'dsh-open-doc.txt\'), path, \'utf8\');\n        return;\n    }\n    await run(\'powershell.exe\', [\n        \'-NoProfile\',\n        \'-Command\',\n        \`Invoke-Item -LiteralPath \${powershellLiteral(path)}\`,\n    ], signal);\n}'
      let patched = false
      for (const oldFn of forms) {
        if (text.includes(oldFn)) {
          text = text.replace(oldFn, finalFn)
          patched = true
          break
        }
      }
      if (patched) {
        writeFileSync(openerPath, text)
        console.log('  + native-path-opener for text file types')
        applied += 1
      } else {
        console.log('  ! native-path-opener openWindowsPath signature mismatch (skipped)')
      }
    }
  }

  return applied
}

// CLI entry: apply patches to the given runtime root (default runtime-host).
if (process.argv[1] && process.argv[1].endsWith('runtime-patches.mjs')) {
  applyRuntimePatches(RUNTIME_ROOT).then((n) => {
    console.log(`runtime patches applied (${n}) to ${RUNTIME_ROOT}`)
  }).catch((error) => {
    console.error('runtime patches failed:', error)
    process.exit(1)
  })
}
