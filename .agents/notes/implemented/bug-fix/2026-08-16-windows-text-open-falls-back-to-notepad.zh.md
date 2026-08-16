# Agent Note：Windows 文本文档打开回退到记事本

Status: implemented

[English](2026-08-16-windows-text-open-falls-back-to-notepad.md) | 中文

## 问题

设置页的“打开配置文件”操作在 Windows 上返回成功却什么都没打开。桌面 GUI 通过 `settings.openDocument` 把设置文档交给 Host，后者用 `prepareDocument()` 解析路径，再用 `openNativeTextFile()` 打开它。在 Windows 上该路径运行 `powershell.exe Invoke-Item -LiteralPath <path>`——与默认意图相同的文件关联打开。全新 Windows 账户上的 YAML 和 JSON 文档通常没有文件关联，此时 `Invoke-Item` 静默无操作且仍以 0 退出，于是 RPC 回答 `opened: true`，客户端对一个肉眼可见失败的操作用户不显示任何错误。

## 决策

Windows 的 `text-editor` 意图不再依赖文件关联。`openWindowsTextEditor()` 通过 PowerShell 运行 `Start-Process -FilePath notepad.exe -ArgumentList <path>`，无论关联与否都让文档在记事本中可见地打开，并且在编辑器退出前返回，因此基于 `execFile` 的命令运行器绝不会被编辑器的 GUI 生命周期阻塞。

改动只涉及一个分支：

- **默认意图保持不变。** `openWindowsPath()` 仍使用 `Invoke-Item`，因此有关联的路径（绑定到浏览器的 `.html`、绑定到编辑器的 `.txt`）继续通过已注册应用打开。
- **WSL 保留 Windows 文件关联。** WSL 解析出的路径仍通过现有 `openWslPath()` 翻译到达 `openWindowsPath()`，因为 Windows 桌面上的路径正是文件关联能服务的场景。

macOS 与 Linux 不变：macOS 已用 `open -t` 绕过关联，Linux 仍使用 `xdg-open`。

## 备选方案

- **text-editor 意图继续用 `Invoke-Item`。** 这就是被报告的问题；不改调用点就无法让无关联的扩展名打开。
- **通过命令运行器直接启动 `notepad.exe`。** `execFile` 会等待子进程退出，因此打开操作会挂起 RPC 直到编辑器关闭；且记事本已承载同一文档时再次打开会静默复用单实例。
- **安装时配置文件关联。** 在安装期间注册 `.yaml`/`.json` 超出了本 harness 的职责范围，会覆盖用户的既有选择，并且仍需要一个编辑器作为指向目标。

## 后果

“打开配置文件”以及其它所有 text-editor 打开（打开文档操作、把文本路径交给原生打开器的 shell Consumer）在 Windows 上现在即使没有关联也会用记事本可见地打开。text-editor 意图不再查询文本格式的既有关联；默认意图仍会遵循它。改动仅限 Windows text-editor 分支，由 `native-path-opener` 适配器测试验证。
