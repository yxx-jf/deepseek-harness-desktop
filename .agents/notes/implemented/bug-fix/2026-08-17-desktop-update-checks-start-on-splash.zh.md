# Agent Note：桌面更新检查从启动画面开始

Status: implemented

[English](2026-08-17-desktop-update-checks-start-on-splash.md) | 中文

## 问题

桌面更新发现既容易错过又容易误读。应用更新检查在主窗口稳定后的十五秒才运行，盯着启动画面的用户看不到任何更新提示；托盘“检查更新”只查询应用安装包，从不查询单独发布的 runtime。发布新 runtime（本项目日常路径）后，托盘操作仍报“已是最新版本”，看起来像是更新器坏了。而当确实存在应用更新时，流程要问两次（下载？然后安装？），于是没有任何自动动作。

第二个缺陷在用户接受更新后显现：安装包通过 GitHub 直连下载，在不稳定的直连网络上长时间停滞且没有进度界面，于是“下载”看起来毫无反应。runtime 引导早已用镜像前缀解决了同一问题；应用更新器却没有。

## 决策

splash 成为常驻启动画面，更新检查从第一帧开始。`boot()` 现在立即创建 splash、用 `onUpdateMessage` 钩子把自动更新器接入 splash 横幅，并立刻调用 `checkForUpdates()` 而不是延迟执行。runtime 引导进度仍通过同一 splash 绘制；主窗口就绪后 splash 关闭。

更新流程是串行序列，只决定一次，先应用后运行环境：

- **先查应用更新并等待。** `boot()` 在触碰 runtime 之前 `await checkAppUpdate()`。检查解析为一个决定：`installing`（用户接受；镜像下载进行中，装完重启）、`declined`（用户保持当前版本）、或 `none`（没有更新安装包，或检查失败）。提示为“发现新版本 vX，是否立即更新？”，按钮“立即更新 / 暂不”。
- **拒绝则一切推迟。** 拒绝应用更新也会跳过本次启动的 runtime 检查：`ensureRuntime` 新增的 `skipUpdateCheck` 直接复用已装 runtime（缺失安装仍会引导，因为没有 Host 应用无法启动）。因此“否”意味着什么都不更新，应用以当前版本启动。
- **接受则只下载安装器。** 本次启动同样跳过 runtime 检查；安装后重启应用，而那次重启（已是最新）再执行 runtime 检查。因此“是”先更新应用，运行环境在下次启动时更新。
- **无应用更新则现在更新 runtime。** 应用已最新时，runtime 引导照常：抓取 manifest、在 splash 中下载、为下次启动安装。
- **更新提示悬浮在 splash 之上。** splash 是置顶窗口，因此主窗口尚不存在时，更新对话框以 splash 窗口为父（`getSplash`）；否则提示会被 splash 盖住。
- **下载给出可见反馈。** 启动阶段 splash 横幅从 `download-progress` 绘制“正在下载新版本… N%”；主窗口可见时改用系统通知宣告下载开始。`SplashSurface.setProgress(percent)` 方法在消息下方驱动一条 CSS 进度条，按百分比去重、每百分点头至多一次 `executeJavaScript`。
- **ensureSplash。** 主窗口就绪后 updater 仍可能收到 `onUpdateProgress`（此时 splash 已关闭）。`ensureSplash` 钩子重新创建 splash 窗口，让下载进度保持可见。
- **已接受的更新不再二次确认。** `update-downloaded` 直接执行 `quitAndInstall()`——用户已说“是”，重启正是承诺的行为。
- **失败有报告。** 下载失败弹出错误对话框并附上 Release 链接，用户可以手动安装而不是盯着空白。
- **下载走镜像。** `setupAutoUpdater` 把 electron-updater 指向与 runtime 同款 CDN 前缀的 generic feed（`DSH_APP_UPDATE_URL`，默认是 dsh-dist 的 `v0.1.0` release 经镜像）。发布安装包时把 `latest.yml`、安装器及其 blockmap 上传到 runtime manifest 旁边；generic feed 从那里读取。
- **托盘操作检查两条通道。** “检查更新…”运行 `checkAppUpdate(true)` 与 `checkRuntimeForUpdates()`：抓取 runtime manifest 并与已装版本比较；存在更新的 runtime 时提供立即重启（下次启动下载），版本一致则保持安静。

`runtime-bootstrap` 导出 `fetchRuntimeManifest(url, fetchImpl)`，让托盘路径复用引导同款的抓取加校验步骤。

## 备选方案

- **保留延迟启动检查。** 更新提示在主窗口忙碌后才到达；启动后走开的用户永远看不到。
- **下载保留两步确认。** 报告的问题正是“没有自动动作”；下载是第一个要自动化的步骤，重启仅在窗口已可见时保留确认。随后被推翻：用户需求是**只问一次**（“是”一路更新到底，“否”保持当前版本），而不是未经提示就下载。
- **经 GitHub provider 直连下载。** 这就是被报告的停滞：直连链路在本网络下慢且不稳、无进度，接受下载后看起来像死了。generic 镜像 feed 复用了 runtime 验证过的镜像路径。
- **通过应用更新通道报告 runtime 过期。** runtime 是独立工件、有独立版本流；并入 electron-updater 会伪造应用发布。托盘操作改为各通道按自身语义报告。
- **不询问直接重启。** 突发重启会丢弃活跃会话的工作；流程先问一次，因此接受后的重启是预期行为而非意外。

## 后果

启动序列现在是串行的、只决定一次：先检查应用更新，用户在任何其它动作之前决定。拒绝则什么都不更新——应用保持当前版本，runtime 检查也被跳过（`skipUpdateCheck` 复用已装 runtime；仅缺失安装仍会引导）。接受则只经镜像下载安装器（带可见进度）并通过重启安装；那次重启（已是最新）再执行 runtime 检查。仅当不存在应用更新时，本次启动才执行 runtime 检查。主窗口尚不存在时，更新提示以置顶的 splash 为父窗口，因此绝不会被它盖住。托盘“检查更新”仍覆盖应用包与远程 runtime 两条通道。发布应用版本把安装器三元组（`latest.yml`、安装器、blockmap）同时上传到 GitHub Release（手动安装）与支撑 generic feed 的 dsh-dist Release（应用内更新）。`skipUpdateCheck` 与缺失 runtime 仍强制引导的行为由 `runtime-bootstrap.spec` 覆盖。
