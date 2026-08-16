# Agent Note: Desktop title bar follows the app theme

Status: implemented

English | [中文](2026-08-17-desktop-title-bar-follows-theme.zh.md)

## Problem

The desktop window's native title bar kept the system default color while the in-app theme (light / dark / system) painted everything below it. In dark mode the app chrome was dark and the title bar stayed light, which read as an unintegrated window.

## Decision

The desktop shell mirrors the app theme onto the native chrome through Electron's `nativeTheme.themeSource`, which drives Windows title-bar dark mode via DWM (`DWMWA_USE_IMMERSIVE_DARK_MODE`) and updates existing windows at runtime through the NativeTheme observer. The three preference values (`light` / `dark` / `system`) map one-to-one, so `system` keeps following the OS in the title bar too.

The wiring has three parts:

- **Preload bridge.** A new sandboxed `resources/preload.cjs` exposes `window.desktop.setNativeTheme(source)` through `contextBridge`, forwarding to `ipcRenderer.invoke('desktop:set-native-theme', source)`. It uses only the sandboxed preload's electron subset (contextBridge, ipcRenderer), no Node APIs.
- **Main-process handler.** `wireDesktopBridge()` registers the IPC handle and assigns `nativeTheme.themeSource` for the three accepted values (anything else is ignored). The handler is registered at boot; the main window loads the preload from the checkout in development and from `desktop-resources/preload.cjs` when packaged.
- **Renderer sync at both theme entry points.** `boot-theme.ts`'s inline script (the pre-plugin interval, before the shell mounts) mirrors the preference so the title bar is correct on the first frame; `ThemePresenter.apply()` mirrors it on every snapshot so runtime switches follow. Both pass the raw preference — never the resolved scheme — so `system` is preserved.

A plain browser has no bridge: `window.desktop` is optional and every call uses optional chaining, so the product UI stays browser-clean with no new imports (client bundle purity is untouched).

## Alternatives considered

- **Frameless window with a custom title bar.** Full control over color and layout, but it replaces the native window controls (minimize/maximize/close) with a front-end bar, IPC window-control plumbing, and a drag region — a much larger change for the same visible result.
- **`titleBarOverlay` with a fixed color.** The overlay color is fixed at window creation on Windows and cannot be changed at runtime, so a theme switch would not follow.
- **Reading the theme preference from disk in the main process.** The preference lives in the Host settings document; reading it in the main process would duplicate ownership and miss runtime switches. The renderer already owns the live preference, so it is the sync source.

## Consequences

The desktop window's title bar follows the in-app theme: dark, light, or system, switching immediately when the user changes the Appearance setting. The web app remains browser-runnable (the bridge is optional), and no dependency is added to client bundles. Packaging carries `preload.cjs` through the existing `resources → desktop-resources` extra-resources copy; the IPC name is namespaced under `desktop:*`. The behavior is covered by the `ThemePresenter` client spec, which asserts that the raw preference (including `system`) reaches the optional bridge.
