# Agent Note：桌面更新检查从启动画面开始

Status: implemented

[English](2026-08-17-desktop-update-checks-start-on-splash.md) | 中文

## 问题

桌面更新发现既容易错过又容易误读。应用更新检查在主窗口稳定后的十五秒才运行，盯着启动画面的用户看不到任何更新提示；托盘“检查更新”只查询应用安装包，从不查询单独发布的 runtime。发布新 runtime（本项目日常路径）后，托盘操作仍报“已是最新版本”，看起来像是更新器坏了。而当确实存在应用更新时，流程要问两次（下载？然后安装？），于是没有任何自动动作。

## 决策

splash 成为常驻启动画面，更新检查从第一帧开始。`boot()` 现在立即创建 splash、用 `onUpdateMessage` 钩子把自动更新器接入 splash 横幅，并立刻调用 `checkForUpdates()` 而不是延迟执行。runtime 引导进度仍通过同一 splash 绘制；主窗口就绪后 splash 关闭。

更新流程在无可丢失内容时全自动，在可能丢失内容时加确认：

- **下载从不询问。** `update-available` 立即开始 `downloadUpdate()`，并通过 splash 报告“发现新版本 vX，正在自动下载…”；`download-progress` 重绘横幅。
- **启动阶段安装全自动。** `update-downloaded` 在主窗口尚不存在时自行 `quitAndInstall()`——没有用户工作可丢失。主窗口已可见时，同一事件在重启前询问“是否立即重启安装？”。
- **托盘操作检查两条通道。** “检查更新…”仍运行应用包检查，现在还会调用 `checkRuntimeForUpdates()`：抓取 runtime manifest 并与已装版本比较；存在更新的 runtime 时提供立即重启（下次启动下载），版本一致则保持安静。

`runtime-bootstrap` 导出 `fetchRuntimeManifest(url, fetchImpl)`，让托盘路径复用引导同款的抓取加校验步骤。

## 备选方案

- **保留延迟启动检查。** 更新提示在主窗口忙碌后才到达；启动后走开的用户永远看不到。
- **下载保留两步确认。** 报告的问题正是“没有自动动作”；下载是第一个要自动化的步骤，重启仅在窗口已可见时保留确认。
- **通过应用更新通道报告 runtime 过期。** runtime 是独立工件、有独立版本流；并入 electron-updater 会伪造应用发布。托盘操作改为各通道按自身语义报告。
- **`update-downloaded` 一律重启。** 活跃会话中突然重启会丢弃工作，因此自动路径仅保留在无窗口的启动阶段。

## 后果

启动应用每次都显示 splash（此前仅在 runtime 下载时显示）、立即检查应用更新，并在主窗口出现前自动安装。托盘“检查更新”现在同时覆盖应用包与远程 runtime，发布任一工件都会在同一操作上显现。splash 横幅只是新增的重绘；runtime 进度条与阶段不变。新增导出 `fetchRuntimeManifest` 由 `runtime-bootstrap.spec` 覆盖。
