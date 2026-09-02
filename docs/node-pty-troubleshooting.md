# node-pty 插件安装失败排查记录（进行中）

> 状态：**待续** — rc.41 已发布但用户机器仍未生效，回家继续排查（见「当前未解之谜」）。
> 更新时间：2026-09-02

## 一、问题现象

- 用户机器（非本机，Windows / Administrator）从**插件市场安装 `DSH-better-sidebar`** 失败。
- `dsh-market` 日志（`dsh-market-log.txt`）报错：

```
dsh-better-sidebar exit=1 err=ELIFECYCLE: node-pty@1.2.0-beta.15 install: `node scripts/prebuild.js || node-gyp rebuild` Exit status 1
```

（更早还有 `node-pty@1.1.0` 版本、`ERR_PNPM_IGNORED_BUILDS: node-pty` 两种错误形态。）

## 二、根因（已确认的三层）

1. **ABI 不匹配**：`node-pty@1.1.0`（npm stable）的 prebuilds 是 **Node 22 / ABI 127** 专用；DSH desktop 的 **Electron 43 / ABI 148** 无法加载（实测加载即失败）。
2. **下载源裁剪 prebuilds**：用户机器的 npm 下载源/代理把 node-pty tarball 里的 `prebuilds/`（`.node` 大文件）剥掉了 → `prebuild.js` 检查 `prebuilds/<platform>-<arch>` 目录失败 → exit 1 → 触发 `node-gyp rebuild`。
3. **无编译工具链**：`node-gyp` 在 Windows 上需要 VS Build Tools / MSVC，用户机器没有 → 编译失败 → `ELIFECYCLE`。

> 结论：与版本 ABI 无关的机器，只要下载源不裁剪 prebuilds 就能装上；用户机器两个坑都踩了（裁剪 + 无工具链）。

## 三、修复演进（版本时间线）

| 版本 | 内容 | 结果 |
|------|------|------|
| rc.37 | 首次打包发布（runtime 缺 5 个包的 `lib/`，含 `dsh-session-turn-outline`） | 首启崩 |
| rc.38 | 重新打包完整 runtime（补齐 lib） | 插件市场能开 |
| rc.39 | `dshmarket 1.38.0→1.39.0` 修复插件市场与 dsh-settings 兼容 | 插件市场正常 |
| rc.40 | 首次 node-pty 修复：`repairProfileNodePtyOverrides` 写 `overrides: node-pty: 1.2.0-beta.15`（npm pin） | **未解决**：仍从 npm 下载被裁剪的包 |
| rc.41 | 改为 vendor 方案：从 runtime 复制完整 node-pty 到 `profile/vendor/node-pty`，override 指向 `file:./vendor/node-pty` | **已发布，但用户机器 override 仍未变 vendor（谜）** |

## 四、当前未解之谜（回家继续的重点）

用户机器已更新到 rc.41（user agent 确认），但 `dsh-market-log` 里安装错误仍是 **`node-pty@1.2.0-beta.15`**（版本 pin 形式），说明 **pnpm 用的是 override 旧值，`repairProfileNodePtyOverrides` 没把 override 改成 `file:./vendor/node-pty`**。

**已排除**：
- 发布包不含修复代码？→ **否**，`dist/win-unpacked/resources/app.asar` 确认含 `ensureYamlBlockEntry`、`file:./vendor`、`vendor/node-pty`。
- runtime 里没有 node-pty？→ **否**，`dsh-runtime-0.1.0-rc.41-f093be23134a.zip` 确认含 `node_modules/node-pty/package.json` + `prebuilds/win32-x64/*`。
- pnpm 沿用旧 lockfile？→ **否**，临时目录实测：已有旧 lockfile（npm pin）后改 override 为 vendor，`pnpm add` 会干净切换到 `node-pty@file:vendor/node-pty`（`resolution: {directory: vendor/node-pty}`）并安装成功。

**可疑点（修复函数提前退出路径，`src/main.ts` `repairProfileNodePtyOverrides`）**：
1. `const runtimePtyDir = join(app.getPath('userData'), 'host', 'node_modules', 'node-pty')` —— 若该路径不存在 → **直接 `return`**，整个修复跳过。
   - 注意：`app.getPath('userData')` 在打包应用 = `%APPDATA%\@deepseek-ai\dsh-desktop`（从 user agent `@deepseek-ai/dsh-desktop/0.1.0-rc.41` 推断）。
2. 读 `runtimePtyDir/package.json` 失败 / version 非 string → `return`。
3. **vendor 复制（`cpSync`）抛异常 → `continue`，跳过本 profile 的 YAML 改写**（这是最可疑的：vendor 复制失败会连 override 都不改）。
4. YAML 改写失败 → catch 静默。

**待验证（回家后用诊断脚本确认）**：
- `[1] runtime node-pty 存在?` → 排除/证实提前 return
- `[3] profile/vendor/node-pty 存在?` → 排除/证实 cpSync 失败 → continue
- `[2] pnpm-workspace.yaml 的 override 值` → 确认是否仍 `node-pty: 1.2.0-beta.15`

## 五、诊断方法

1. **用户机器诊断脚本**（桌面已有 `DSH_node-pty诊断.bat`，仓库 `docs/DSH_node-pty诊断.bat`）：
   - [1] runtime node-pty 是否存在（`%APPDATA%\@deepseek-ai\dsh-desktop\host\node_modules\node-pty`）
   - [2] profile `pnpm-workspace.yaml` 的 override/allowBuilds 内容
   - [3] `profile/vendor/node-pty` 是否存在
   - [4] profiles 目录列表
   - [5] host 目录是否存在
2. **Electron 加载 node-pty 验证**（本机/任何机器）：
   ```bat
   set ELECTRON_RUN_AS_NODE=1
   "<repo>\node_modules\electron\dist\electron.exe" load-test.js
   ```
   （`require` 目标 node-pty 的 `package.json` 版本 + `spawn` 类型）
3. **临时目录完整模拟**（不污染真实 profile）：
   - 全新 profile：`vendor` + `file:./vendor/node-pty` override + `allowBuilds: 'node-pty@file:vendor/node-pty': true` → `pnpm add dsh-better-sidebar` 成功（已验证，`$env:TEMP\bsb-verify`）
   - 迁移：先 npm pin 装出旧 lockfile → 改 vendor override → `pnpm add` 切到 vendor（已验证，`$env:TEMP\migrate-add`）
4. **YAML 改写逻辑**（`ensureYamlBlockEntry`）：已有独立脚本验证幂等 + 旧 pin 替换 + 无块追加（`$env:TEMP\yaml-test*.js`）。

## 六、待办清单

- [ ] 用 `DSH_node-pty诊断.bat` 在用户机器跑一次，拿到 [1][2][3] 结果
- [ ] 根据结果修复 `repairProfileNodePtyOverrides` 的提前退出路径（重点：vendor 复制失败不应跳过 YAML 改写；runtime 缺失时也应保证 override 指向 vendor 或写诊断日志）
- [ ] 必要时给修复函数加**落盘日志**（主进程 console.log 打包后不可见，可写 `%APPDATA%\@deepseek-ai\dsh-desktop\repair.log`）便于远程定位
- [ ] 重新发布 rc.42
- [ ] **更新流程优化**（用户反馈）：手动「检查更新」当前是 `checkAppUpdate(true)` + `checkRuntimeForUpdates()` **并行**触发（`src/main.ts` L1624），造成"外壳下载 + runtime 分包下载同时进行、进入对话界面后又弹安装包"。改为**串行**：先壳层、无更新再 runtime（启动流程已有 `skipRuntimeUpdate`，仅手动入口未串行）。
- [ ] 收尾清理：桌面调试脚本（`修复DSH插件node-pty.bat`、`DSH_node-pty诊断.bat`）可留作离线兜底

## 七、相关代码位置

- `src/main.ts`
  - `repairProfileNodePtyOverrides()`（约 L781）—— 本次修复核心
  - `ensureYamlBlockEntry()`（约 L725）—— YAML 块注入/幂等
  - `repairProfileAllowBuildsPlaceholders()`（约 L672）—— 修 pnpm `set this to true or false` 占位 bug
  - `boot()` 调用点（约 L1777，在 `ensurePnpmEnvironment` 之后、市场挂载之前）
- `src/updater.ts` —— `checkAppUpdate` / `setupAutoUpdater`（壳层更新）
- `src/runtime-bootstrap.ts` —— runtime manifest 版本检测/下载

## 八、关键路径与命令

```text
用户机器 runtime node-pty:  %APPDATA%\@deepseek-ai\dsh-desktop\host\node_modules\node-pty
用户机器 profile:            %USERPROFILE%\.dsh\profiles\web
用户机器 workspace 配置:      %USERPROFILE%\.dsh\profiles\web\pnpm-workspace.yaml
```

```sh
pnpm run build:shell        # 编译壳层（tsc + tsdown → lib/main.js）
pnpm run release:gitee      # 完整发布（dist:thin + publish:gitee）
```

- Gitee stable 更新源：`https://gitee.com/yixiao-xiao/dsh-pc-release/releases/download/stable/`
