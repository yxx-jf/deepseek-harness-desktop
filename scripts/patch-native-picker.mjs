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

/**
 * Patch the picker worker's main execution to route through a temp-file bridge
 * when the packaged Host sets `DSH_DESKTOP_BRIDGE_PICKER=1`.
 *
 * WHY: the worker drives the Win32 folder dialog through koffi (FFI). Under
 * Electron's `ELECTRON_RUN_AS_NODE` the embedded Node's NAPI ABI mismatches the
 * prebuilt koffi native module, so `koffi.view()`/`decode` abort the process
 * (FATAL, code 134) after the dialog closes — the worker never reports a
 * result. Instead of fixing the ABI, the packaged Host hands the dialog to the
 * Electron main process (`dialog.showOpenDialog`, the real native picker) via
 * a request/result file pair: the worker writes `dsh-pick-dir.txt` with the
 * dialog title, polls `dsh-pick-dir-result.txt`, and reports the chosen path.
 * Development keeps the koffi path (real node, native dialog, working IPC).
 */
export function patchWorkerDesktopBridge(runtimeRoot = RUNTIME_ROOT) {
  const nativeLib = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib')
  const workerPath = join(nativeLib, 'worker.cjs')
  if (!existsSync(workerPath)) {
    console.warn(`[patch-native-picker] no worker at ${workerPath}; skipping bridge`)
    return
  }
  console.log(`[patch-native-picker] adding desktop bridge branch in ${workerPath}`)
  if (hasMarker(workerPath, 'DSH_DESKTOP_BRIDGE_PICKER')) {
    console.log('  = worker desktop bridge already patched')
    return
  }
  // Anchor on the worker's main execution preamble. It must stay unique and
  // match the compiled worker exactly (tab-indented, as shipped).
  const anchor = [
    '(async () => {',
    '\ttry {',
    '\t\tpost({',
    '\t\t\tkind: "done",',
    '\t\t\tpath: runFolderDialog(await loadWin32DialogBindings(), title, (threadId) => {',
  ].join('\n')
  const bridge = [
    '(async () => {',
    '\t// Desktop bridge: under ELECTRON_RUN_AS_NODE the koffi FFI below crashes',
    '\t// (NAPI ABI mismatch), so a packaged Host sets DSH_DESKTOP_BRIDGE_PICKER=1',
    '\t// and this worker asks the Electron main process to show the real native',
    '\t// folder dialog via dialog.showOpenDialog (temp-file request/result).',
    '\tif (process.env.DSH_DESKTOP_BRIDGE_PICKER === "1") {',
    '\t\tconst { writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");',
    '\t\tconst { join } = await import("node:path");',
    '\t\tconst tmp = process.env.TEMP || process.env.TMP || "/tmp";',
    '\t\tconst reqFile = join(tmp, "dsh-pick-dir.txt");',
    '\t\tconst resFile = join(tmp, "dsh-pick-dir-result.txt");',
    '\t\ttry { rmSync(resFile, { force: true }); } catch {}',
    '\t\twriteFileSync(reqFile, title, "utf8");',
    '\t\tconst deadline = Date.now() + 120000;',
    '\t\tlet path = null;',
    '\t\twhile (Date.now() < deadline) {',
    '\t\t\ttry {',
    '\t\t\t\tif (existsSync(resFile)) {',
    '\t\t\t\t\tconst text = readFileSync(resFile, "utf8").trim();',
    '\t\t\t\t\tpath = (text === "" || text === "__CANCELLED__") ? null : text;',
    '\t\t\t\t\tbreak;',
    '\t\t\t\t}',
    '\t\t\t} catch {}',
    '\t\t\tawait new Promise((resolve) => setTimeout(resolve, 100));',
    '\t\t}',
    '\t\ttry { rmSync(reqFile, { force: true }); } catch {}',
    '\t\ttry { rmSync(resFile, { force: true }); } catch {}',
    '\t\tpost({ kind: "done", path });',
    '\t\treturn;',
    '\t}',
    '\ttry {',
    '\t\tpost({',
    '\t\t\tkind: "done",',
    '\t\t\tpath: runFolderDialog(await loadWin32DialogBindings(), title, (threadId) => {',
  ].join('\n')
  replace(workerPath, anchor, bridge, 'worker: desktop bridge branch')
  console.log(`[patch-native-picker] ${applied} replacement(s) applied`)
  return null
}

/**
 * Force the adaptive directory-picker to the pure-Node `browse` backend in the
 * packaged desktop.
 *
 * WHY: the native Win32 backend drives its dialog from a spawned child process
 * (`process.execPath` = Electron under `ELECTRON_RUN_AS_NODE`), and spawning
 * Electron children is unreliable in the packaged environment — the worker
 * exits before reporting a result. The `browse` backend is a plain Node
 * one-level directory listing with no child process and no native dialog, so
 * pinning every packaged boot to `browse` sidesteps the fragile spawn. The
 * Host must also receive `DSH_FORCE_DIRECTORY_PICKER=browse` in its env
 * (src/main.ts), and the desktop shell applies this patch idempotently at
 * packaging time (verify-packaged-runtime.ts).
 *
 * These edits target the COMPILED lib/ file (what the runtime actually loads),
 * so they live in the desktop repo and are applied idempotently on every build.
 */
export function patchAutoPickerForceBrowse(runtimeRoot = RUNTIME_ROOT) {
  const indexPath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-auto', 'lib', 'index.js')
  if (!existsSync(indexPath)) {
    console.warn(`[patch-auto-picker] runtime has no auto picker at ${indexPath}; skipping`)
    return
  }
  console.log(`[patch-auto-picker] forcing browse backend in ${runtimeRoot}`)
  if (!hasMarker(indexPath, 'DSH_FORCE_DIRECTORY_PICKER')) {
    replace(
      indexPath,
      'function resolveDirectoryPickerBackend(facts) {\n\tif (facts.bindHost !== "127.0.0.1") return "browse";',
      'function resolveDirectoryPickerBackend(facts) {\n\tif (process.env.DSH_FORCE_DIRECTORY_PICKER === "browse") return "browse";\n\tif (facts.bindHost !== "127.0.0.1") return "browse";',
      'auto-picker: force browse via DSH_FORCE_DIRECTORY_PICKER',
    )
  } else {
    console.log('  = auto-picker already patched')
  }
  return null
}

/**
 * Make the dsh-market install GitHub-source plugins without a `git` binary.
 *
 * WHY: the market hands pnpm a `github:owner/repo` (or
 * `github:owner/repo#path:/sub` for monorepo subpackages) dependency for
 * GitHub-hosted plugins, and pnpm resolves the unpinned shortcut with
 * `git ls-remote` — which the packaged desktop (and many user machines) does
 * not have, failing with `git ls-remote failed: 'git' 不是内部或外部命令`.
 * The market's own accelerator (lib/accelerate.js) already resolves HEAD over
 * plain HTTP (`/info/refs?service=git-upload-pack`, no git needed) and rewrites
 * the target to a commit-pinned `github:owner/repo#<sha>`, which pnpm downloads
 * straight from codeload.github.com without ever invoking git. But
 * `acceleratedTarget` bails out early when the region has no GitHub mirror
 * (`githubProxy === null`, the default `global` region), leaving the unpinned
 * shortcut in place and forcing pnpm down the git path.
 *
 * This patch replaces `acceleratedTarget` so it always resolves HEAD through
 * HTTP (a default `https://gh-proxy.com` mirror, overridable via
 * `DSHM_GITHUB_PROXY`) and pins the commit — for BOTH bare repos and `#path:`
 * subpath selectors (kept as `&path:/...` after the pinned SHA, pnpm's syntax
 * for a pinned subpath, see sources.js `githubTargetAtCommit`). Every GitHub
 * install then avoids git entirely.
 *
 * The edits target the COMPILED lib/ file (what the runtime actually loads),
 * applied idempotently on every build.
 */
export function patchMarketGitResolve(runtimeRoot = RUNTIME_ROOT) {
  const indexPath = join(runtimeRoot, 'node_modules', 'dshmarket', 'lib', 'accelerate.js')
  if (!existsSync(indexPath)) {
    console.warn(`[patch-market-git] runtime has no dshmarket accelerate at ${indexPath}; skipping`)
    return
  }
  console.log(`[patch-market-git] enabling no-git GitHub resolution in ${runtimeRoot}`)

  if (hasMarker(indexPath, 'DSHM_GITHUB_RESOLVE_V2')) {
    console.log('  = market git resolve already patched')
    return
  }

  const text = readFileSync(indexPath, 'utf8')
  const signature = 'export async function acceleratedTarget(target, region, env = process.env) {'
  const start = text.indexOf(signature)
  if (start === -1) {
    console.warn('  ! market acceleratedTarget signature not found (skipped)')
    return
  }
  // The function ends with its finally/timer close; resolveHeadCommit (defined
  // earlier in the file) shares the same tail, so anchor from the signature's
  // offset to grab THIS function's closing brace.
  const tail = 'clearTimeout(timer);\n    }\n}'
  const tailAt = text.indexOf(tail, start)
  if (tailAt === -1) {
    console.warn('  ! market acceleratedTarget tail not found (skipped)')
    return
  }
  const end = tailAt + tail.length
  const original = text.slice(start, end)

  // v2 body: resolve HEAD over HTTP (mirror default, overridable via
  // DSHM_GITHUB_PROXY) and pin the commit for BOTH bare repos and #path:/
  // subpath selectors (pnpm's pinned-subpath syntax `#<sha>&path:/...`).
  const v2 = [
    'export async function acceleratedTarget(target, region, env = process.env) {',
    '    /* DSHM_GITHUB_RESOLVE_V2 (desktop): resolve HEAD over HTTP even without',
    '       a region mirror so pnpm never needs the git binary for github: plugins,',
    '       pinning both bare repos and #path:/ subpath selectors. */',
    '    const proxy = routesFor(region, env).githubProxy ?? "https://gh-proxy.com";',
    '    const shortcut = /^github:([A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+?)(?:\\.git)?(?:#(.*))?$/.exec(target);',
    '    if (shortcut === null)',
    '        return target;',
    '    const repo = shortcut[1];',
    '    let subpath = null;',
    '    for (const selector of (shortcut[2] ?? \'\').split(\'&\')) {',
    '        const pathMatch = /^path:\\/(.+)$/.exec(selector);',
    '        if (pathMatch !== null) subpath = pathMatch[1];',
    '    }',
    '    const controller = new AbortController();',
    '    const timer = setTimeout(() => { controller.abort(); }, RESOLVE_TIMEOUT_MS);',
    '    try {',
    '        const sha = await headCommit(repo, proxy, controller.signal);',
    '        if (sha === null) {',
    '            logEvent(\'info\', \'region\', `${repo}: could not resolve a commit through the mirror; installing directly`);',
    '            return target;',
    '        }',
    '        return `github:${repo}#${sha}${subpath === null ? \'\' : `&path:/${subpath}`}`;',
    '    }',
    '    finally {',
    '        clearTimeout(timer);',
    '    }',
    '}',
  ].join('\n')

  writeFileSync(indexPath, `${text.slice(0, start)}${v2}${text.slice(end)}`)
  console.log(`  + market: v2 no-git GitHub resolution (${original.includes('DSHM_FORCE_GITHUB_RESOLVE') ? 'upgraded' : 'pristine'})`)
  return null
}

// Allow import as a module (from verify-packaged-runtime / release scripts) and
// direct CLI execution.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    patchNativePicker()
    patchWorkerDesktopBridge()
    patchAutoPickerForceBrowse()
    patchMarketGitResolve()
  } catch (error) {
    console.error(`[patch-native-picker] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}