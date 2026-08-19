# Agent Note: Desktop remote runtime bootstrap

Status: implemented

English | [中文](2026-08-16-desktop-remote-runtime-bootstrap.zh.md)

## Problem

The packaged desktop shell shipped its Host runtime inside the installer: electron-builder embedded the staged `runtime-host/` tree (17,948 files, ~187 MB) as `resources/host`. A fresh install therefore unpacked the entire payload (the installer was ~139 MB and took tens of seconds to unpack tens of thousands of files), and updates replaced it in place. There was no path to a two-step distribution where a small installer lands and the runtime downloads on first launch — the shape third-party repackagers of this product use.

## Decision

**The installer ships the Electron shell only; the Host runtime downloads on first launch into the per-user data directory. The two-step shape is the default.** `publish:runtime --write-config` runs before the dist scripts so the installer carries `desktop-resources/runtime-config.json`, and `verify-packaged-runtime.ts` rejects a packaged shell with neither a bundled `resources/host` nor a configured manifest URL, so a dist run without the remote config fails at pack time instead of shipping a broken installer. Bundling the runtime back into the installer (an offline layout) is opt-in: add `runtime-host/package.json` and `runtime-host/node_modules` back to `extraResources`. Startup resolves the manifest URL from `DSH_RUNTIME_MANIFEST_URL` or the bundled config; failure is loud.

`src/runtime-bootstrap.ts` owns the remote flow and imports no Electron APIs: it fetches the manifest, compares versions, downloads the archive, verifies its SHA-256, streams the ZIP into a staging directory, checks the Host CLI entry, writes a `runtime-manifest.json` marker, and swaps the staging directory into `userData/host` (keeping the previous install until the rename lands). Progress is reported as phases (`fetching-manifest`, `downloading`, `extracting`, `installing`, `ready`). A frameless splash window (`src/splash.ts` + `resources/splash.html`) renders progress and appears only once a real download starts. The packaged app extracts the archive with a worker pool (`src/parallel-extract.ts` + `src/zip-index.ts` + `src/extract-worker.ts`): the ZIP central directory is parsed, entries are balanced across up to 16 workers that inflate and write concurrently, and any failure falls back to the serial streaming extractor (`extractZip` in `src/runtime-bootstrap.ts`).

`scripts/publish-runtime.ts` produces the downloadable artifacts from the same staged tree: it re-runs `stage-runtime.ts`, ZIPs `runtime-host/` with the synchronous `zipSync` (level-9 DEFLATE, fixed timestamps), writes a `runtime-manifest.json` with a content-addressed version (`<app version>-<stage hash prefix>`), and can write `resources/runtime-config.json` (`--write-config`) so the next installer build bundles the manifest URL. `zipSync` is used because fflate 0.8.3's streaming Zip writer (`Zip`/`ZipDeflate`) corrupts some inputs — inflate reports `invalid distance` on round-trip — while the synchronous path round-trips correctly; the staged tree is ~500 MB, acceptable for a one-shot publish step. `fflate` is the archive library on both sides and is inlined into the shell bundle (`deps.alwaysBundle`), because the packaged shell ships no `node_modules`.

**The runtime download must use Chromium's network stack, not Node's built-in fetch.** The shell injects Electron `net.fetch` into the bootstrap (`RuntimeBootstrapOptions.fetch`); Node's bundled CA bundle rejected the first real install with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` on a machine whose Windows store carries a locally installed root (an intercepting proxy or security suite), while Chromium validates against the OS store and honors system proxy settings, and `curl`/the OS store succeeded. The bootstrap stays pure Node and testable because the fetch is an injected option defaulting to the global fetch.

**Downloads retry and fall back to mirrors instead of hanging on a stalled link.** A real first-launch install stalled at 3% with no bytes arriving for tens of seconds — a flaky direct link to the release CDN, not a proxy (the machine's system proxy was disabled). Each download attempt is aborted when no bytes arrive for `downloadStallTimeoutMs` (default 20s) or after `downloadTimeoutMs`, each URL is retried `downloadRetries` times, and then `mirrorPrefixes` are tried, every attempt gated by the manifest SHA-256. The packaged shell defaults to the `https://gh-proxy.com/` mirror prefix for networks where GitHub releases stall; `DSH_RUNTIME_MIRRORS` (comma-separated prefixes) overrides it.

## Alternatives considered

**Use electron-builder's `nsis-web` target.** Rejected: the download runs inside the NSIS window with the native progress UI, not the product's own splash; it needs a `publish` configuration or an `appPackageUrl`; and with this repository's `compression: "store"` the downloaded package would be uncompressed anyway. It also cannot drive the later plugin-market workflow that installs into the same runtime directory.

**Keep the runtime always bundled and never downloaded.** Rejected: it forecloses the two-step install the packaging work exists to provide.

**Self-host the splash inside the web frontend.** Rejected: the Host (which serves the frontend) is exactly what the bootstrap must download before it can start; the splash is therefore a static HTML page driven from the main process.

## Consequences

Packaging requires a runtime source: `verify-packaged-runtime.ts` accepts a bundled `resources/host` when present, otherwise it demands `desktop-resources/runtime-config.json` with a `manifestUrl`, so a dist run without `publish:runtime --write-config` fails at pack time instead of shipping a broken installer. A configured remote path fails loudly on manifest, checksum, or extraction errors and cleans up its staging and download directories; the previous runtime survives until the swap lands. Dropping the bundled runtime shrank the installer from ~139 MB to ~96 MB and cut a fresh install from unpacking 17,948 files to ~8s. The runtime lives in `userData/host` when bootstrapped, so uninstaller "delete app data" semantics apply to it. Runtime updates become independent of shell releases because the version is content-addressed from the staged tree.
