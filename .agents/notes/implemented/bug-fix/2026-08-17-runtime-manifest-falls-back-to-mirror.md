# Agent Note: Runtime manifest fetches fall back to the mirror

Status: implemented

English | [中文](2026-08-17-runtime-manifest-falls-back-to-mirror.zh.md)

## Problem

Startup intermittently failed with `runtime manifest fetch failed: HTTP 502` and a second launch succeeded. The runtime archive had long downloaded through mirror prefixes (`https://gh-proxy.com/`), but the manifest — the small JSON that names the archive — was still fetched directly from the GitHub release URL. On a flaky direct connection the manifest is the first byte to fail, so the whole launch aborted before the mirror could ever help.

## Decision

The manifest fetch now mirrors the archive's resilience. `fetchRuntimeManifestWithMirrors(url, fetchImpl, mirrors)` tries the primary URL, then each mirror prefix prepended to it, returning the first valid manifest. Both consumers use it:

- `ensureRuntime` fetches through the configured `mirrorPrefixes` (the same list the archive download uses).
- `checkRuntimeForUpdates` (the tray's runtime channel) builds the same mirror list from `DSH_RUNTIME_MIRRORS` or the default prefix.

The archive SHA-256 gate is unchanged; a mirror that serves a different manifest still cannot pass an invalid archive. `fetchRuntimeManifest` remains exported as the single-URL primitive.

## Alternatives considered

- **Pointing the packaged config at a mirror URL.** Simpler, but only fixes machines whose config already points at the mirror and does nothing for the tray check that reads the same primary URL; the runtime fallback fixes every caller and every deployment.
- **Fetching the manifest through the archive download path.** The archive downloader streams bytes and hashes them; the manifest is small and validated by `validateManifest`, so a lighter fetch-then-validate loop is the right shape.

## Consequences

A flaky direct link no longer aborts startup: the manifest falls back to the mirror exactly like the archive, so the first launch succeeds as often as the second. The change is confined to the manifest fetch step; both the new helper and the still-strict validation are covered by `runtime-bootstrap.spec`.
