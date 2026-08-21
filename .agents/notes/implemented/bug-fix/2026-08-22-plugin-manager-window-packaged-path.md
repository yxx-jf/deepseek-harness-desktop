# Agent Note: Plugin manager window does not open in packaged builds

Status: implemented

English | [中文](2026-08-22-plugin-manager-window-packaged-path.zh.md)

## Problem

After packaging, clicking 插件管理 did not pop a window, while the dev build worked. `openPluginManager()` built the BrowserWindow with `show: false` and only calls `manager.show()` inside `.then()` of `loadFile(...)`. It resolved the preload and HTML from `join(DESKTOP_DIR, 'resources/plugin-manager-*')`.

`DESKTOP_DIR` is the source checkout root (`resolve(dirname(import.meta.url), '..')`), which in a packaged app points into `app.asar`. The plugin-manager files are copied by `extraResources` (resources → `desktop-resources`) to `process.resourcesPath/desktop-resources/`, not into the asar. So `loadFile` failed, `.then(show)` never ran, and the hidden window never appeared — an install-time + launch-time failure that passes development.

## Decision

Follow the existing two-state resource pattern already used for the splash, the main preload, and the tray icons:

- added `pluginManagerPreloadPath()` and `pluginManagerHtmlPath()`, each returning `process.resourcesPath/desktop-resources/<file>` when `app.isPackaged` else `DESKTOP_DIR/resources/<file>`;
- `openPluginManager()` now uses them for `webPreferences.preload` and `loadFile`.

## Alternatives considered

- **Moving `resources/` into the asar `files` list.** Would let the hardcoded path work but duplicates the tray/splash resources and fights the established `extraResources` layout.
- **Keeping the hardcoded path with a fallback probe.** Masks the bug; the two-state helpers are the house style.

## Consequences

The plugin manager window opens in both dev and packaged modes. General rule recorded: any BrowserWindow resource path in this shell must use the `app.isPackaged ? process.resourcesPath/desktop-resources/... : DESKTOP_DIR/resources/...` pattern.