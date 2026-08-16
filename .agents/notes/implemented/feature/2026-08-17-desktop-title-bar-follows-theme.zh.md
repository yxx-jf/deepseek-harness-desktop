# Agent Note：桌面标题栏跟随应用主题

Status: implemented

[English](2026-08-17-desktop-title-bar-follows-theme.md) | 中文

## 问题

桌面窗口的原生标题栏保持系统默认色，而应用内主题（浅色 / 深色 / 跟随系统）只影响其下方的内容。深色模式下应用界面是深色、标题栏却是浅色，看起来像是没有集成的窗口。

## 决策

桌面壳通过 Electron 的 `nativeTheme.themeSource` 把应用主题镜像到原生 chrome：它在 Windows 上经 DWM（`DWMWA_USE_IMMERSIVE_DARK_MODE`）驱动标题栏深色模式，并通过 NativeTheme observer 在运行时更新已有窗口。三个偏好值（`light` / `dark` / `system`）一一对应，因此 `system` 在标题栏上也保持跟随操作系统。

接线分三部分：

- **Preload 桥。** 新增 sandboxed `resources/preload.cjs`，通过 `contextBridge` 暴露 `window.desktop.setNativeTheme(source)`，转发到 `ipcRenderer.invoke('desktop:set-native-theme', source)`。只用 sandboxed preload 的 electron 子集（contextBridge、ipcRenderer），不触碰 Node API。
- **主进程处理器。** `wireDesktopBridge()` 注册 IPC handle，对三个可接受值（其它一律忽略）赋 `nativeTheme.themeSource`。处理器在 boot 时注册；主窗口在开发环境从 checkout 加载 preload，打包后从 `desktop-resources/preload.cjs` 加载。
- **两个主题入口处的渲染端同步。** `boot-theme.ts` 的内联脚本（插件激活前的阶段，shell 挂载前）镜像偏好，使标题栏首帧即正确；`ThemePresenter.apply()` 在每个快照上镜像，使运行时切换即时生效。两者都传**原始偏好**——绝不传解析后的 scheme——以保留 `system`。

普通浏览器没有桥：`window.desktop` 是可选的，所有调用都用可选链，因此产品 UI 在浏览器中依然干净、无需新增 import（客户端 bundle 纯度不受影响）。

## 备选方案

- **无边框窗口 + 自定义标题栏。** 颜色与布局完全可控，但要替换原生窗口控制（最小化 / 最大化 / 关闭）为前端标题栏、IPC 窗口控制管线与拖拽区域——为同样的可见效果付出大得多的改动。
- **`titleBarOverlay` 固定颜色。** overlay 颜色在 Windows 窗口创建时固定、运行时不可改，主题切换无法跟随。
- **主进程从磁盘读主题偏好。** 偏好存放在 Host 设置文档里；主进程读取会重复所有权且错过运行时切换。渲染端本就持有实时偏好，因此由它作为同步源。

## 后果

桌面窗口标题栏跟随应用主题：深色、浅色或跟随系统，用户改动“外观”设置时立即切换。Web 应用仍可浏览器运行（桥是可选的），客户端 bundle 不新增依赖。打包通过现有 `resources → desktop-resources` extra-resources 拷贝携带 `preload.cjs`；IPC 名称以 `desktop:*` 为命名空间。行为由 `ThemePresenter` 客户端 spec 覆盖，它断言原始偏好（包括 `system`）会到达可选桥。
