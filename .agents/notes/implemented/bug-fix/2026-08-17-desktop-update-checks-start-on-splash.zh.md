# Agent Note：桌面更新检查从启动画面开始

Status: implemented

[English](2026-08-17-desktop-update-checks-start-on-splash.md) | 中文

## 问题

桌面更新发现既容易错过又容易误读。应用更新检查在主窗口稳定后的十五秒才运行，盯着启动画面的用户看不到任何更新提示；托盘“检查更新”只查询应用安装包，从不查询单独发布的 runtime。发布新 runtime（本项目日常路径）后，托盘操作仍报“已是最新版本”，看起来像是更新器坏了。而当确实存在应用更新时，流程要问两次（下载？然后安装？），于是没有任何自动动作。

第二个缺陷在用户接受更新后显现：安装包通过 GitHub 直连下载，在不稳定的直连网络上长时间停滞且没有进度界面，于是“下载”看起来毫无反应。runtime 引导早已用镜像前缀解决了同一问题；应用更新器却没有。

## 决策

splash 成为常驻启动画面，更新检查从第一帧开始。`boot()` 现在立即创建 splash、用 `onUpdateMessage` 钩子把自动更新器接入 splash 横幅，并立刻调用 `checkForUpdates()` 而不是延迟执行。runtime 引导进度仍通过同一 splash 绘制；主窗口就绪后 splash 关闭。

更新流程只问一次，然后一路到底：

- **用户确认更新。** `update-available` 询问“发现新版本 vX，是否立即更新？”，按钮为“立即更新 / 暂不”。选择“暂不”标记本次会话拒绝更新（下次检查再问）；选择“立即更新”开始 `downloadUpdate()`。
- **下载给出可见反馈。** 启动阶段 splash 横幅从 `download-progress` 绘制“正在下载新版本… N%”；主窗口可见时改用系统通知宣告下载开始。
- **已接受的更新不再二次确认。** `update-downloaded` 直接执行 `quitAndInstall()`——用户已说“是”，重启正是承诺的行为。
- **失败有报告。** 下载失败弹出错误对话框并附上 Release 链接，用户可以手动安装而不是盯着空白。
- **下载走镜像。** `setupAutoUpdater` 把 electron-updater 指向与 runtime 同款 CDN 前缀的 generic feed（`DSH_APP_UPDATE_URL`，默认是 dsh-dist 的 `v0.1.0` release 经镜像）。发布安装包时把 `latest.yml`、安装器及其 blockmap 上传到 runtime manifest 旁边；generic feed 从那里读取。
- **托盘操作检查两条通道。** “检查更新…”仍运行应用包检查，现在还会调用 `checkRuntimeForUpdates()`：抓取 runtime manifest 并与已装版本比较；存在更新的 runtime 时提供立即重启（下次启动下载），版本一致则保持安静。

`runtime-bootstrap` 导出 `fetchRuntimeManifest(url, fetchImpl)`，让托盘路径复用引导同款的抓取加校验步骤。

## 备选方案

- **保留延迟启动检查。** 更新提示在主窗口忙碌后才到达；启动后走开的用户永远看不到。
- **下载保留两步确认。** 报告的问题正是“没有自动动作”；下载是第一个要自动化的步骤，重启仅在窗口已可见时保留确认。随后被推翻：用户需求是**只问一次**（“是”一路更新到底，“否”保持当前版本），而不是未经提示就下载。
- **经 GitHub provider 直连下载。** 这就是被报告的停滞：直连链路在本网络下慢且不稳、无进度，接受下载后看起来像死了。generic 镜像 feed 复用了 runtime 验证过的镜像路径。
- **通过应用更新通道报告 runtime 过期。** runtime 是独立工件、有独立版本流；并入 electron-updater 会伪造应用发布。托盘操作改为各通道按自身语义报告。
- **不询问直接重启。** 突发重启会丢弃活跃会话的工作；流程先问一次，因此接受后的重启是预期行为而非意外。

## 后果

启动应用每次都显示 splash（此前仅在 runtime 下载时显示）、立即检查应用更新，并在接受后经镜像下载（带可见进度）并通过重启安装。拒绝则本次会话保持当前版本。托盘“检查更新”现在同时覆盖应用包与远程 runtime，发布任一工件都会在同一操作上显现。发布应用版本现在把安装器三元组（`latest.yml`、安装器、blockmap）同时上传到 GitHub Release（手动安装）与支撑 generic feed 的 dsh-dist Release（应用内更新）。splash 横幅只是新增的重绘；runtime 进度条与阶段不变。新增导出 `fetchRuntimeManifest` 由 `runtime-bootstrap.spec` 覆盖。
