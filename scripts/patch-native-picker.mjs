#!/usr/bin/env node
/**
 * Patch the bundled native directory-picker for the packaged desktop shell.
 *
 * WHY: the native Win32 folder dialog is driven by a child process (worker.cjs)
 * whose protocol is Node's IPC channel (`process.send`). Under Electron's
 * `ELECTRON_RUN_AS_NODE` mode the IPC channel is not established, so the worker
 * throws at the top level ("must run as a child process with an IPC channel")
 * and the parent reports "win32 folder dialog worker exited before reporting a
 * result". The worker therefore speaks BOTH transports: IPC when available,
 * JSON-lines on stdout otherwise, and the driver reads both.
 *
 * These edits target the COMPILED lib/ files (which are what the runtime loads),
 * so they live in the desktop repo and are applied idempotently on every build —
 * an upstream sync or fresh clone produces the same patched runtime, no manual
 * editing of generated files.
 *
 * Usage:
 *   node scripts/patch-native-picker.mjs [runtimeRoot]
 *   # runtimeRoot defaults to <desktop>/runtime-host
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_ROOT = resolve(process.argv[2] ?? join(DESKTOP_ROOT, 'runtime-host'))
const NATIVE_LIB = join(RUNTIME_ROOT, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib')

let applied = 0

/** Apply one exact-text replacement; count successes, fail loudly on missing anchors. */
function replace(target, needle, replacement, label) {
  const src = readFileSync(target, 'utf8')
  const occurrences = src.split(needle).length - 1
  if (occurrences === 0) {
    throw new Error(`[patch-native-picker] anchor not found in ${target}: ${label}`)
  }
  if (occurrences > 1) {
    throw new Error(`[patch-native-picker] anchor is not unique (${occurrences}x) in ${target}: ${label}`)
  }
  writeFileSync(target, src.replace(needle, replacement))
  applied += 1
  console.log(`  + ${label}`)
}

/** True when a marker string is already present (idempotency guard). */
function hasMarker(target, marker) {
  return existsSync(target) && readFileSync(target, 'utf8').includes(marker)
}

export function patchNativePicker(runtimeRoot = RUNTIME_ROOT) {
  const nativeLib = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib')
  const workerPath = join(nativeLib, 'worker.cjs')
  const indexPath = join(nativeLib, 'index.js')
  if (!existsSync(workerPath)) {
    console.warn(`[patch-native-picker] runtime has no native picker worker at ${workerPath}; skipping`)
    return
  }
  applied = 0
  console.log(`[patch-native-picker] patching native directory picker in ${runtimeRoot}`)

  if (!hasMarker(workerPath, 'typeof process.send === "function"')) {
    // 1. Remove the hard IPC-only guard.
    replace(
      workerPath,
      'if (process.send === void 0) throw new Error("win32-dialog-worker must run as a child process with an IPC channel");',
      '',
      'worker: drop IPC-only guard',
    )
    // 2. Conditional send binding.
    replace(
      workerPath,
      'const send = process.send.bind(process);',
      'const send = typeof process.send === "function" ? process.send.bind(process) : void 0;',
      'worker: conditional send binding',
    )
    // 3. post(): use IPC when present, else write JSON lines to stdout.
    replace(
      workerPath,
      'const post = (message) => {\n\t/* v8 ignore next 3 -- disconnect needs a live IPC channel the unit lane must not sever (built-worker.e2e.ts owns the real close path). */\n\tsend(message, () => {\n\t\tif (process.connected) process.disconnect();\n\t});\n};',
      'const post = (message) => {\n\t/* v8 ignore next 4 -- Electron ELECTRON_RUN_AS_NODE may lack the Node IPC channel; the driver also reads JSON lines from stdout. */\n\tif (send !== void 0) {\n\t\tsend(message, () => {\n\t\t\tif (process.connected) process.disconnect();\n\t\t});\n\t} else {\n\t\tprocess.stdout.write(JSON.stringify(message) + "\\n");\n\t}\n};',
      'worker: stdout fallback in post()',
    )
  } else {
    console.log('  = worker.cjs already patched')
  }

  if (!hasMarker(indexPath, 'worker.on("message", onMessage)')) {
    // 4. Pipe stdout so the driver can read JSON lines when IPC is absent.
    replace(
      indexPath,
      'const stdio = [\n\t\t"ignore",\n\t\t"inherit",\n\t\t"inherit",\n\t\t"ipc"\n\t];',
      'const stdio = [\n\t\t"ignore",\n\t\t"pipe",\n\t\t"inherit",\n\t\t"ipc"\n\t];',
      'driver: pipe child stdout',
    )
    // 5. Rename the inline IPC listener to a named dispatcher.
    replace(
      indexPath,
      'worker.on("message", (message) => {',
      'const onMessage = (message) => {',
      'driver: named onMessage dispatcher',
    )
    // 6. Close the dispatcher and wire both transports (IPC + stdout lines).
    replace(
      indexPath,
      '\t\t\t\tdefault: assertNever(message);\n\t\t\t}\n\t\t});',
      '\t\t\t\tdefault: assertNever(message);\n\t\t\t}\n\t\t};\n\t\tworker.on("message", onMessage);\n\t\tlet stdoutBuffer = "";\n\t\tworker.stdout?.on("data", (chunk) => {\n\t\t\tstdoutBuffer += chunk.toString();\n\t\t\tlet nl;\n\t\t\twhile ((nl = stdoutBuffer.indexOf("\\n")) >= 0) {\n\t\t\t\tconst line = stdoutBuffer.slice(0, nl).trim();\n\t\t\t\tstdoutBuffer = stdoutBuffer.slice(nl + 1);\n\t\t\t\tif (line === "") continue;\n\t\t\t\ttry { onMessage(JSON.parse(line)); } catch { /* skip malformed */ }\n\t\t\t}\n\t\t});',
      'driver: wire stdout JSON-line feed',
    )
  } else {
    console.log('  = index.js already patched')
  }

  console.log(`[patch-native-picker] ${applied} replacement(s) applied`)
  return null
}

// Allow import as a module (from verify-packaged-runtime / release scripts) and
// direct CLI execution.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    patchNativePicker()
  } catch (error) {
    console.error(`[patch-native-picker] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}