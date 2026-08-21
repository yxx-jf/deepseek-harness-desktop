# Agent Note：插件管理窗口在打包后打不开

Status: implemented

[English](2026-08-22-plugin-manager-window-packaged-path.md) | 中文

## 问题

打包后点击"插件管理"不弹窗，开发模式却正常。`openPluginManager()` 用 `show: false` 创建 BrowserWindow，并且只在 `loadFile(...)` 的 `.then()` 里调用 `manager.show()`。它从 `join(DESKTOP_DIR, 'resources/plugin-manager-*')` 解析 preload 与 HTML。

`DESKTOP_DIR` 是源码检出根目录（`resolve(dirname(import.meta.url), '..')`），打包后指向 `app.asar` 内部。而插件管理的文件由 `extraResources`（resources → `desktop-resources`）复制到 `process.resourcesPath/desktop-resources/`，并不在 asar 里。于是 `loadFile` 失败、`.then(show)` 永不执行、隐藏窗口永远不出现——这是开发模式通过、打包必现的启动期故障。

## 决策

沿用壳内已有的两态资源路径模式（splash、主 preload、托盘图标都一样）：

- 新增 `pluginManagerPreloadPath()` 与 `pluginManagerHtmlPath()`，各自在 `app.isPackaged` 时返回 `process.resourcesPath/desktop-resources/<file>`，否则返回 `DESKTOP_DIR/resources/<file>`；
- `openPluginManager()` 改用它们作为 `webPreferences.preload` 与 `loadFile`。

## 备选方案

- **把 `resources/` 并入 asar 的 `files`。** 能让写死的路径成立，但会重复托盘/splash 资源，与既有的 `extraResources` 布局冲突。
- **保留写死路径并加探测回退。** 掩盖了问题本身；两态 helper 才是本仓库的风格。

## 后果

插件管理窗口在开发与打包两种模式下都能打开。记录的通用规则：本壳内任何 BrowserWindow 的资源路径都必须使用 `app.isPackaged ? process.resourcesPath/desktop-resources/... : DESKTOP_DIR/resources/...` 的两态写法。