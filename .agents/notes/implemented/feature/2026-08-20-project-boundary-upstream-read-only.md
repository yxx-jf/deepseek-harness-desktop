# Agent Note: Project boundary — upstream is read-only

Status: implemented

English | [中文](2026-08-20-project-boundary-upstream-read-only.zh.md)

## Rule (hard boundary, do not violate)

- The `upstream/` directory is the upstream source (the deepseek-harness upstream repository). **Never modify any file inside it.**
- All product changes must land only in the desktop shell's own files: `src/`, `resources/`, `scripts/`, `assets/`, `build/`, etc.
- Files under `upstream/` may be read for research/understanding, but must never be written.

## Keep default: do not touch upstream

- Do not edit `upstream/**` unless the user explicitly, in the same request, authorizes an upstream change.
- If an upstream file seems to need a change, stop and ask — there is almost always a desktop-shell-side way to achieve the same goal (IPC bridge, preload injection, main-process handling, patches in `$DSH_HOME`, etc.).

## Background

- The desktop repo (`deepseek-harness-desktop`) is a wrapper/shell over the upstream DSH web host. Feature work belongs in the shell, not the upstream clone.
- A past mistake: `upstream/packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx` was edited by an agent and had to be reverted after the owner corrected this boundary. Documented here so it does not recur.