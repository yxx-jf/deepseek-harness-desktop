# DeepSeek Harness Desktop

English | [中文](README.zh.md)

Electron desktop shell for the loopback `dsh web` Host: a native window plus a
system tray that owns the application lifetime, while the Host process keeps
sessions and background work running even after the window closes.

The shell is a **pure addition to the repository**. It does not join the host
or client compiler aggregates, does not change `apps/web`, and reaches the
product only through stable contracts:

- `apps/cli/lib/bin.js` (the built `dsh` CLI entry)
- the `dsh web` readiness line (`dsh web: http://127.0.0.1:<port>`)
- `@deepseek-ai/dsh-web-frontend/dist` (the built browser UI)

Upstream updates therefore cannot break packaging unless they change one of
those interfaces.

## Commands

```sh
pnpm run dev:desktop       # build everything, then launch the Electron window
pnpm run package:desktop   # build + stage Host runtime + unpacked app (no installer)
pnpm run dist:desktop      # build + stage Host runtime + platform installer
pnpm run dist:win          # explicit Windows NSIS installer (full build)
pnpm run dist:win:fast     # NSIS installer for shell-only changes (see below)
```

### Build speed

`dist:win` runs the full workspace build first, so it is the path to use after
an upstream pull. For changes confined to the desktop shell (`src/`, icons,
`resources/`) use `dist:win:fast`: it rebuilds only the shell, reuses the
staged Host runtime when nothing upstream changed, and packages the installer
in roughly the time electron-builder alone needs.

`scripts/stage-runtime.ts` fingerprints every input of the staged Host runtime
(the lockfile, the regenerated runtime manifest, and the file stamps of every
included workspace package). An unchanged fingerprint reuses
`apps/desktop/runtime-host/` and skips the full `pnpm deploy` plus symlink
materialization; pass `--force` to rebuild it unconditionally.

The installer payload is ~600 MB across ~32k files (Electron runtime plus the
flat Host `node_modules`), so a fresh install takes a few minutes on typical
disks; updates reuse the same version and replace files in place.

## How the packaged app runs

`electron-builder` embeds two things:

1. **The shell** (`apps/desktop`) — window, tray, and Host supervisor.
2. **The Host runtime** (`runtime-host/` → `resources/host/`) — a flat
   `node_modules` containing the built CLI, every product workspace package,
   and the built Web frontend.

At startup the packaged shell runs the Host in a separate process using
**Electron's own bundled Node** (`ELECTRON_RUN_AS_NODE=1`), so the installer
ships no second Node executable. The window loads the loopback URL the Host
emits; navigation is locked to that origin and external links open in the
system browser.

## Windows installer behavior

The NSIS installer stops a running app before replacing its files. Because the
app closes to the tray, an ordinary window close keeps the process alive, so
the desktop shell treats a close of a **tray-hidden** window as an external
request (installer/uninstaller graceful close, Windows session end, shutdown)
and quits the application instead of re-hiding it. Quitting from inside the
process also succeeds when the installer's force-kill would be denied — an
unelevated installer cannot kill an elevated app (`allowElevation: false`,
`perMachine: false`), which is the one remaining case where the installer may
ask to close the app manually: if the app was launched **as administrator**,
close its window (or quit from the tray) before running the installer.

On Windows the packaged app additionally watches for a running
`DeepSeek-Harness-*.exe` installer process and quits itself within a second of
one starting, so an update install never has to kill a running app at all —
even an elevated one.

The staged Host runtime is pruned of `*.d.ts` and `*.map` files before
packaging (never loaded by the Node runtime; the deepest generated declaration
names would exceed MAX_PATH once installed), and `build/installer.nsh` installs
a long-path-aware `customRemoveFiles` uninstaller macro, so update installs do
not abort with "Failed to uninstall old application files" on over-long package
paths.

## The staged Host runtime

`scripts/stage-runtime.ts` produces `apps/desktop/runtime-host/`:

1. Regenerates `apps/desktop/runtime/package.json` from the current workspace
   (`scripts/generate-runtime-manifest.ts`) so every product package resolves
   as a bare Cordis plugin.
2. Runs the repository's `verify-runtime-closure` gate on that manifest.
3. `pnpm deploy --legacy --prod` materializes a flat `node_modules`, then
   symlinks are replaced with real bytes.
4. Scans the composed web profile's cordis yml files and rejects the build if
   any referenced `@deepseek-ai/*` plugin is absent.
5. `electron-builder`'s `afterPack` hook re-checks the CLI entry and frontend
   dist inside the completed app.

## Remote runtime bootstrap

The installer ships the Electron shell only; the Host runtime and its
dependencies download on first launch from a remote manifest into the
per-user data directory (`userData/host`). Packaging a broken shell is
rejected up front: the `afterPack` hook (`scripts/verify-packaged-runtime.ts`)
accepts a bundled `resources/host` when present, otherwise it requires
`desktop-resources/runtime-config.json` with a `manifestUrl`, so the dist
scripts must run after `publish:runtime --write-config`.

### Publishing the runtime

`publish-runtime` reuses the staged tree and produces the artifacts to host:

```sh
pnpm run publish:runtime --url https://cdn.example.com/dsh --write-config
```

This re-runs `stage-runtime`, ZIPs `apps/desktop/runtime-host/` into
`dsh-runtime-<version>-<stage-hash-prefix>.zip`, and writes a
`runtime-manifest.json` (version, URL, SHA-256, size) next to it. Upload both
files to the base URL. `--write-config` also writes
`apps/desktop/resources/runtime-config.json`, which the next installer build
bundles as `desktop-resources/runtime-config.json` so the shell knows the
manifest URL. The base URL also comes from `DSH_RUNTIME_PUBLISH_URL`, and
`--out` overrides the output directory (default `apps/desktop/dist/runtime`).

### Activating the remote path

A packaged app bootstraps the remote runtime from `DSH_RUNTIME_MANIFEST_URL`
or the bundled `runtime-config.json`; a bundled `resources/host` is used only
when neither is configured (an opt-in offline installer — add
`runtime-host/package.json` and `runtime-host/node_modules` back to
`extraResources`). While downloading, a dark splash window reports progress
(`src/splash.ts`, `resources/splash.html`). The runtime installs under
`userData/host` with a `runtime-manifest.json` marker, so updates replace it
in place and an up-to-date install skips the download entirely. Manifest,
checksum, or extraction failures abort startup loudly and clean up their
staging directories.

Extraction runs in a worker pool (`src/parallel-extract.ts`): the ZIP central
directory is parsed (`src/zip-index.ts`), entries are balanced across up to
16 workers that inflate and write concurrently (`src/extract-worker.ts`), and
any failure falls back to the serial streaming extractor (`extractZip` in
`src/runtime-bootstrap.ts`). The small-file disk write is the hard floor, so
parallelism buys CPU time; on a development NVMe the 17,948-file runtime
extracts in ~7s versus ~9s serial.

The runtime download uses Electron's `net.fetch` (Chromium's network stack),
injected into the bootstrap, not Node's built-in `fetch`: Chromium validates
certificates against the OS store and honors system proxy settings, while
Node's bundled CA bundle rejects machines with locally installed roots
(intercepting proxies, security suites) with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
The bootstrap stays pure Node and testable because the fetch is an injected
option (`RuntimeBootstrapOptions.fetch`), defaulting to the global fetch.

Downloads are resilient to flaky links to release CDNs: an attempt is aborted
when no bytes arrive for 20s (`downloadStallTimeoutMs`) or after the overall
`downloadTimeoutMs`, each URL is retried (`downloadRetries`), and then mirror
prefixes are tried (`mirrorPrefixes`), each attempt gated by the manifest
SHA-256. The packaged shell defaults to the `https://gh-proxy.com/` mirror
for networks where GitHub releases stall; override with
`DSH_RUNTIME_MIRRORS` (comma-separated prefixes).

## App self-update (in-app online updates)

The installer ships with [electron-updater](https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater) wired to the GitHub Releases source declared in `build.publish` (`yxx-jf/deepseek-harness-desktop`). The tray action "检查更新…" and a silent startup check look for a newer installer; a found update downloads and installs on restart (`src/updater.ts`). This is separate from the runtime bootstrap, which still swaps the runtime on every launch.

Publishing an app update uploads the installer update triple — the `.exe`, `latest.yml`, and the `.exe.blockmap` (all produced by electron-builder) — to the same release:

```sh
gh release create v0.1.0-rc.6 apps/desktop/dist/DeepSeek-Harness-*.exe apps/desktop/dist/latest.yml apps/desktop/dist/DeepSeek-Harness-*.exe.blockmap -R yxx-jf/deepseek-harness-desktop
```

**Version channel rule**: electron-updater updates within the same prerelease channel only — an app built as `0.1.0-rc.5` detects newer `*-rc.*` releases but ignores stable ones. Point customers at stable version numbers (`0.1.0`, `0.2.0`, …) so they track every future release.

## Updating after an upstream pull

```sh
git pull
pnpm install
pnpm run build
pnpm run dist:desktop        # or package:desktop for an unpacked test build
```

If upstream adds a new product package that the web profile composes, the
staged-profile scan in step 4 fails with the missing package name; regenerate
the runtime manifest (stage-runtime does this automatically) and commit the
updated `apps/desktop/runtime/package.json` if it changes.

## Networks that block GitHub releases

Electron's binary and electron-builder's signing tools are downloaded from
GitHub releases during packaging. On networks where that fails (TLS errors,
timeouts), point both downloads at the npmmirror before running `dist:desktop`:

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:NODE_OPTIONS = "--use-system-ca"   # when a proxy CA is not trusted
pnpm run dist:desktop
```

These env vars affect the build-time tooling only. The packaged app's runtime
download already uses Chromium's network stack, which trusts the OS
certificate store and reads system proxy settings, so no per-user
`NODE_OPTIONS` is needed for the app itself.

The API key is entered in the app's **Settings → Models** and stored under the
user home (`~/.dsh`); the packaged app does not read the repository `.env`.

## Icons

The app carries the designer-produced multi-platform icon set (from the
`DeepSeek Harness_icons` LogoGen export). The per-size PNGs are wrapped into
the container formats **verbatim** — their exact pixels are embedded, no
scaling or re-encoding — and committed as static assets:

| File | Source | Used by |
|---|---|---|
| `build/icon.ico` | windows/icon-{16,32,48,64,128,256}.png | Windows app, taskbar, shortcuts |
| `build/icon.icns` | macos/icon_{16..1024}.png (incl. @2x) | macOS app |
| `build/icon.png` | linux/icon-256.png | Linux AppImage + fallback |
| `resources/trayTemplate.png` | windows/icon-32.png | tray |
| `resources/tray.png` | windows/icon-32.png | tray |

To refresh from a new designer export, re-wrap the PNGs into `icon.ico` /
`icon.icns` (the same container assembly the export uses) and repackage.

## Layout

```text
apps/desktop/
  src/             Electron main process (window, tray, Host supervisor)
  scripts/         staging, manifest generation, icon generation, afterPack gate
  runtime/         dependency-only deploy root (@deepseek-ai/dsh-desktop-runtime)
  build/icon.png   application icon
  resources/       tray icon
  runtime-host/    staged Host runtime (generated, git-ignored)
  dist/            electron-builder output (generated, git-ignored)
```
