# DeepSeek Harness Desktop

English | [中文](README.zh.md)

Electron desktop shell for the loopback `dsh web` Host: a native window plus a
system tray that owns the application lifetime, while the Host process keeps
running sessions and background work even after the window closes.

The shell is a **pure addition** to the repository. It reaches the product only
through stable contracts, so upstream updates cannot break packaging unless
they change:

- `apps/cli/lib/bin.js` — the built `dsh` CLI entry
- the `dsh web` readiness line (`dsh web: http://127.0.0.1:<port>`)
- `@deepseek-ai/dsh-web-frontend/dist` — the built browser UI

## Commands

```sh
pnpm run dev:desktop       # full build, then launch the Electron window
pnpm run package:desktop   # build + stage Host runtime, unpacked app
pnpm run dist:desktop      # build + stage Host runtime + platform installer
pnpm run dist:win          # Windows NSIS installer (full workspace build)
pnpm run dist:win:fast     # NSIS installer, shell-only changes
```

Use `dist:win:fast` for shell-only changes (`src/`, icons, `resources/`): it
rebuilds only the shell and reuses the already-staged Host runtime when nothing
upstream changed. `scripts/stage-runtime.ts` fingerprints the staged runtime's
inputs; an unchanged fingerprint reuses `runtime-host/` and skips the full
`pnpm deploy` (pass `--force` to rebuild). The installer is ~600 MB across
~32k files, so a fresh install takes a few minutes.

## How the packaged app runs

`electron-builder` embeds:

1. **The shell** (`apps/desktop`) — window, tray, Host supervisor.
2. **The Host runtime** (`runtime-host/` → `resources/host/`) — a flat
   `node_modules` with the built CLI, every product package, and the built Web
   frontend.

The packaged shell runs the Host in a separate process using Electron's own
Node (`ELECTRON_RUN_AS_NODE=1`), so no second Node is shipped. The window loads
the loopback URL the Host emits; navigation is locked to that origin.

## Remote runtime bootstrap

The installer ships the shell only; the Host runtime downloads on first launch
from a remote manifest into `userData/host`. The `afterPack` hook
(`scripts/verify-packaged-runtime.ts`) rejects a shell with neither a bundled
`resources/host` nor a `manifestUrl` config, so dist must run after
`publish:runtime --write-config`. An up-to-date install skips the download;
manifest/checksum/extraction failures abort startup loudly.

### Publishing the runtime

```sh
pnpm run publish:runtime --url <base-url> --write-config
```

Re-stages the runtime, ZIPs `runtime-host/` into
`dsh-runtime-<version>-<stage-hash>.zip`, and writes `runtime-manifest.json`
(version, URL, SHA-256, size). Host both files under the base URL.
`--write-config` writes `resources/runtime-config.json`, which the next
installer build bundles so the shell knows the manifest URL. The base URL also
comes from `DSH_RUNTIME_PUBLISH_URL`; `--out` overrides the output directory
(default `dist/runtime`).

A packaged app bootstraps from `DSH_RUNTIME_MANIFEST_URL` or the bundled
`runtime-config.json`; a bundled `resources/host` is used only when neither is
set (opt-in offline installer — add the `runtime-host/*` files back to
`extraResources`). The download uses Chromium's network stack (trusts OS certs,
honors system proxy) and is resilient to flaky links: stall/timeout triggers
retries and mirror fallbacks (`DSH_RUNTIME_MIRRORS`, defaulting to a GitHub
proxy mirror), all gated by the manifest SHA-256. Extraction runs in a pool of
up to 16 parallel workers with a serial fallback.

## App self-update

The installer ships `electron-updater` wired to the GitHub Releases source in
`build.publish` (`yxx-jf/deepseek-harness-desktop`). The tray "检查更新…" action
and a silent startup check find newer installers and install them on restart
(`src/updater.ts`). Publish by uploading the update triple — `.exe`,
`latest.yml`, `.exe.blockmap` — to the same release:

```sh
gh release create v<ver> dist/DeepSeek-Harness-*.exe dist/latest.yml dist/DeepSeek-Harness-*.exe.blockmap -R yxx-jf/deepseek-harness-desktop
```

**Version channel rule**: updates stay within the same prerelease channel — an
app built as `0.1.0-rc.5` only sees newer `*-rc.*`. Ship stable versions
(`0.1.0`, `0.2.0`, …) for customers.

## One-command release

The full release — build the shell, generate runtime artifacts, build the NSIS
installer, upload everything to a GitHub Release — is a single command:

```sh
$env:GH_TOKEN = "..."   # or put GH_TOKEN=... in .env (needs repo scope)
pnpm run release
```

## Updating after an upstream pull

```sh
git pull
pnpm install
pnpm run build
pnpm run dist:desktop        # or package:desktop for an unpacked test build
```

## Networks that block GitHub releases

When Electron's build-time downloads fail (TLS errors, timeouts), point them at
npmmirror and retry:

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:NODE_OPTIONS = "--use-system-ca"
pnpm run dist:desktop
```

These variables affect build-time tools only; the packaged app's runtime
download already uses Chromium's network stack. API keys are entered in
**Settings → Models** and stored under `~/.dsh`; the packaged app does not read
the repository `.env`.

## Icons

The icon features the **DeepSeek Whale Girl** character by
[fornarwhal](https://github.com/fornarwhal), sourced from
[fornarwhal/deepseek-whale-girl-icon](https://github.com/fornarwhal/deepseek-whale-girl-icon)
(`improved-1.png`, 984×984). It is scaled into `build/icon.ico`, `icon.icns`,
`icon.png`, and the tray icons under `resources/`.

## Layout

```text
src/             Electron main process (window, tray, Host supervisor)
scripts/         staging, manifest generation, icon generation, afterPack gate
runtime/         dependency-only deploy root (@deepseek-ai/dsh-desktop-runtime)
build/           application icon (icon.ico, icon.icns, icon.png)
resources/       tray icon, runtime config, splash UI
runtime-host/    staged Host runtime (generated, git-ignored)
dist/            electron-builder output (generated, git-ignored)
```

## License

[MIT](LICENSE)
