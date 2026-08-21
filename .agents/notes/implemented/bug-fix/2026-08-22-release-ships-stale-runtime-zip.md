# Agent Note: Release ships a stale runtime zip that 404s

Status: implemented

English | [中文](2026-08-22-release-ships-stale-runtime-zip.zh.md)

## Problem

A freshly released app failed first launch with `runtime archive download failed: HTTP 404` for the archive URL in `releases/download/v0.1.0-rc.12/...`. The release's `runtime-manifest.json` named a zip (`dsh-runtime-<version>-<hash>.zip`) that was not among the uploaded assets.

Root causes, confirmed from file timestamps and the live release:

- `publish:runtime` writes a **content-addressed** zip whose `<hash>` changes between builds, but it never cleaned `dist/runtime/`, so stale zips accumulated (e.g. `cd998…` from 8/21 and `fd0d5…` from 8/22 were both present).
- `release.ts` uploaded the **first** `dsh-runtime-*.zip` returned by `readdir` (alphabetically the stale one) without checking it against the manifest. The manifest pointed at the newer hash, so clients hit 404.

The install step (`installStagedRuntime`) runs before the executable can boot, so a mismatched manifest aborts startup for every non-developer install.

## Decision

Two-layer fix, so the source of truth is the manifest `url`:

- `scripts/publish-runtime.ts` now purges `outDir` of old `dsh-runtime-*.zip` files and the old `runtime-manifest.json` before writing the new ones. The output dir therefore always holds exactly the current zip + its manifest.
- `scripts/release.ts` cleans `dist/runtime/` with Node's `fs.rm` before publishing (shell `rm -rf` is unreliable under Windows `cmd.exe`), and selects the zip by the filename in `manifest.url` instead of taking the first `readdir` result. It also passes `dsh-runtime-<version>-` as a delete prefix so stale zips of the same version are removed from the release.
- `uploadAsset` gained an optional `deletePrefix` that deletes every matching existing asset, not just the same name.

## Alternatives considered

- **Only cleaning `dist/runtime` in `release.ts`.** Fixes the immediate run but leaves `publish-runtime` usable standalone, where a manual publish still accumulates stale zips that a later uploader could pick.
- **Versioning the zip name without a hash.** Would stop hash mismatch but discards content-addressing used to detect unchanged runtimes and skip downloads.

## Consequences

Re-releasing the same tag now replaces all runtime assets consistently; the uploaded zip always matches `runtime-manifest.json`. `get_errors` did not flag the missing `rm` import in the first edit — verify imports by reading the file, not just the LSP, before running `pnpm run release`.