# Agent Note：发布时上传了过期的运行时 zip 导致 404

Status: implemented

[English](2026-08-22-release-ships-stale-runtime-zip.md) | 中文

## 问题

新发布的应用首次启动失败，报 `runtime archive download failed: HTTP 404`，指向 `releases/download/v0.1.0-rc.12/...` 下的归档 URL。Release 上的 `runtime-manifest.json` 指向一个 zip（`dsh-runtime-<version>-<hash>.zip`），但该 zip 并不在已上传的资产中。

结合文件时间戳与线上 Release 确认了根因：

- `publish:runtime` 写入的是**内容寻址** zip，`<hash>` 每次构建都可能变，但它从不清理 `dist/runtime/`，于是旧 zip 不断累积（例如 8/21 的 `cd998…` 和 8/22 的 `fd0d5…` 同时存在）。
- `release.ts` 上传的是 `readdir` 返回的**第一个** `dsh-runtime-*.zip`（按字母序恰好是那个旧的），且不与 manifest 比对。manifest 指向更新的 hash，于是客户端全部 404。

安装步骤（`installStagedRuntime`）在可执行文件启动之前就跑，因此 manifest 不匹配会让每个非开发安装都在启动时中止。

## 决策

双层修复，让 `manifest.url` 成为唯一事实来源：

- `scripts/publish-runtime.ts` 现在在写新产物前先把 `outDir` 里旧的 `dsh-runtime-*.zip` 与旧的 `runtime-manifest.json` 清掉。输出目录因此始终只放着"当前 zip + 对应 manifest"。
- `scripts/release.ts` 在发布前用 Node 的 `fs.rm` 清理 `dist/runtime/`（Windows `cmd.exe` 下 shell `rm -rf` 不可靠），并按 `manifest.url` 里的文件名选取 zip，而不是取 `readdir` 的第一个结果；同时传 `dsh-runtime-<version>-` 作为删除前缀，把同版本的旧 zip 从 Release 上清掉。
- `uploadAsset` 新增可选参数 `deletePrefix`：删除所有匹配前缀的既有资产，而不仅是同名的那一个。

## 备选方案

- **只在 `release.ts` 里清理 `dist/runtime`。** 能修当次运行，但 `publish-runtime` 单独使用仍会累积旧 zip，之后任一下载方都可能取到旧的。
- **zip 命名去掉 hash。** 能杜绝 hash 不匹配，但丢掉了用于"运行时未变则跳过下载"的内容寻址能力。

## 后果

现在重新发布同一 tag 会一致地替换所有运行时资产，上传的 zip 一定与 `runtime-manifest.json` 匹配。第一次编辑时 `get_errors` 并未报出漏了 `rm` 导入——跑 `pnpm run release` 前要读源码核对导入，不能只靠 LSP。