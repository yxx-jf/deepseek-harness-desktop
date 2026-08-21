# Agent Note: Runtime download stalls — broken mirror and short stall timeout

Status: implemented

English | [中文](2026-08-22-runtime-download-mirror-and-timeout.zh.md)

## Problem

After the manifest fetch was fixed, the packaged app progressed to `runtime archive download failed after 4 attempt(s): The operation was aborted`. Measured on the machine:

| path | speed |
|---|---|
| direct GitHub | ~8.6 KB/s (48.6 MB → ~1.6 h) |
| `gh-proxy.com` mirror | ~1.4 MB/s (~35 s) |
| `ghfast.top` mirror | ~86 KB/s |
| `github.akams.cn` (old default) | HTTP 404 |

Two compounding bugs: the default mirror `github.akams.cn` was dead (404 for every proxied request), so once the primary URL failed the fallback immediately died too; and the 20 s `downloadStallTimeoutMs` watchdog aborted the 48 MB stream whenever no bytes arrived for 20 s on a slow/unstable link.

## Decision

- Default mirror for both runtime paths changed from `github.akams.cn` to **`gh-proxy.com`** (verified working at ~1.4 MB/s).
- Removed `github.akams.cn` from the `githubMirrorPrefixes()` fallback list.
- Bumped `downloadStallTimeoutMs` from 20 s to **60 s** in the `ensureRuntime` call. `downloadTimeoutMs` (overall cap, default 300 s) was left as-is.
- Synced **both** mirror sites: the manifest fetch uses `DSH_RUNTIME_MIRRORS ?? 'https://gh-proxy.com/'` (single default) and the archive download uses the `githubMirrorPrefixes()` list — editing only one leaves the other stale.

## Alternatives considered

- **Only raising the timeout.** Leaves the dead mirror as the fallback, so every slow-network user still aborts after the primary times out.
- **Bundling the runtime into the installer (offline).** Would remove the download entirely but inflates the installer by ~600 MB and complicates updates; rejected as a default.

## Consequences

On the test network the runtime zip now downloads in ~35 s through the mirror, comfortably inside both the stall and overall timeouts. Mirrors are third-party and can die — before a release, verify the default with `curl --max-time 15 -w "%{speed_download}" https://gh-proxy.com/<full-url>`.