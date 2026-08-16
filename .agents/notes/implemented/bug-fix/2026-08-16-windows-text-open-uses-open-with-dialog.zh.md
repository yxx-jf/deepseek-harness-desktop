# Agent Note：Windows 文本文档打开回退到“打开方式”对话框

Status: implemented

[English](2026-08-16-windows-text-open-uses-open-with-dialog.md) | 中文

## 问题

设置页的“打开配置文件”操作在 Windows 上返回成功却什么都没打开。桌面 GUI 通过 `settings.openDocument` 把设置文档交给 Host，后者用 `prepareDocument()` 解析路径，再用 `openNativeTextFile()` 打开它。在 Windows 上该路径运行 `powershell.exe Invoke-Item -LiteralPath <path>`——与默认意图相同的文件关联打开。全新 Windows 账户上的 YAML 和 JSON 文档通常没有文件关联，此时 `Invoke-Item` 静默无操作且仍以 0 退出，于是 RPC 回答 `opened: true`，客户端对一个肉眼可见失败的操作用户不显示任何错误。

## 决策

Windows 的 `text-editor` 意图不再依赖文件关联，也不再固定某个编辑器。`openWindowsTextEditor()` 先读取 `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\<ext>` 下的 `UserChoice` 值：

- **存在关联**（记录了 `ProgId`）——`Invoke-Item -LiteralPath <path>` 用已注册应用打开文档，尊重用户为该格式已选的编辑器。
- **不存在关联**——`rundll32.exe shell32.dll,OpenAs_RunDLL <短路径>` 弹出 Windows“打开方式”对话框，让用户选择程序。Windows 随后把选择记录为关联，因此下一次打开会走 `Invoke-Item` 分支。

rundll32 的 `OpenAs_RunDLL` 会在第一个空格处截断参数，带空格路径会让对话框一闪而过，因此对话框分支先解析 8.3 短路径（`Scripting.FileSystemObject` 的 `ShortPath`）；短路径永远不含空格。对话框由 shell 托管，所以 rundll32 在用户完成选择之前就退出，基于 `execFile` 的命令运行器绝不会被对话框生命周期阻塞。

改动只涉及一个分支：

- **默认意图保持不变。** `openWindowsPath()` 仍使用 `Invoke-Item`，因此有关联的路径（绑定到浏览器的 `.html`、绑定到编辑器的 `.txt`）继续通过已注册应用打开。
- **WSL 保留 Windows 文件关联。** WSL 解析出的路径仍通过现有 `openWslPath()` 翻译到达 `openWindowsPath()`，因为 Windows 桌面上的路径正是文件关联能服务的场景。

macOS 与 Linux 不变：macOS 已用 `open -t` 绕过关联，Linux 仍使用 `xdg-open`。

## 备选方案

- **固定记事本（最初交付的修复）。** 无关联时能可靠打开文档，但会覆盖既有关联且用户无法选择编辑器；随后被“打开方式”对话框取代。
- **用原始路径调用 `OpenAs_RunDLL`。** 无空格时可靠，但带空格路径（用户名含空格的用户配置文件）会让对话框一闪而过——而首次打开 YAML 的机器恰恰可能如此。
- **给带空格路径加双重引号。** 实测仍会关闭对话框；只有不含空格的短路径保持可靠。
- **安装时配置文件关联。** 在安装期间注册 `.yaml`/`.json` 超出了本 harness 的职责范围，会覆盖用户的既有选择，并且仍需要一个编辑器作为指向目标。

## 后果

“打开配置文件”以及其它所有 text-editor 打开（打开文档操作、把文本路径交给原生打开器的 shell Consumer）在 Windows 上现在有关联时通过关联程序打开，无关联时弹出 Windows“打开方式”对话框让用户选择——之后 Windows 记住该关联，后续打开直接进入所选编辑器。改动仅限 Windows text-editor 分支，由 `native-path-opener` 适配器测试验证。当系统全局禁用 8.3 短名创建时，`ShortPath` 返回原始路径，带空格路径仍可能遭遇 rundll32 的截断；常见配置文件位置（`%USERPROFILE%\.dsh`）很少含空格。
