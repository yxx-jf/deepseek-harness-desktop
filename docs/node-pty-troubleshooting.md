# node-pty 插件安装失败排查记录（进行中）

> 状态：**rc.44 已发布** — rc.43 因旧 lib 回灌导致首启崩（见 `docs/rc43-runtime-stale-lib-troubleshooting.md`，已由 rc.44 从干净 workspace 重建 runtime 解决）。rc.44 runtime `0.1.0-rc.44-bf9eec5ce294` 扫描 0 个旧符号。
> 更新时间：2026-09-03

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
| rc.42 | 加固 repair 提前退出路径（落盘 `repair.log` + vendor 复制失败不跳过 YAML + runtime 缺失回退兄弟 profile vendor）+ 手动检查更新串行 | 已发布（本机验证时首启崩：runtime 缺 `lib/`） |
| rc.43 | stage 加 `repairBrokenPackageEntries`（缺入口包从 registry 自愈 + 扩展名解析修复）；workspace 完整重建（runtime-host 回灌 232 包 lib + tsdown 重建 util-time/util-values/code-runtime-python）；vendor/cordis 误删 git 恢复；清理 build 残留目录；重新发布 | **已发布，运行时完整** |

## 四、根因候选与 rc.42 加固

用户机器在 rc.41 时 `dsh-market-log` 里安装错误仍是 **`node-pty@1.2.0-beta.15`**（版本 pin 形式），说明 **pnpm 用的是 override 旧值，rc.41 的 `repairProfileNodePtyOverrides` 没把 override 改成 `file:./vendor/node-pty`**。rc.42 已针对该函数的提前退出路径全部加固。

**已排除**：
- 发布包不含修复代码？→ **否**，`dist/win-unpacked/resources/app.asar` 确认含 `ensureYamlBlockEntry`、`file:./vendor`、`vendor/node-pty`。
- runtime 里没有 node-pty？→ **否**，`dsh-runtime-0.1.0-rc.41-f093be23134a.zip` 确认含 `node_modules/node-pty/package.json` + `prebuilds/win32-x64/*`。
- pnpm 沿用旧 lockfile？→ **否**，临时目录实测：已有旧 lockfile（npm pin）后改 override 为 vendor，`pnpm add` 会干净切换到 `node-pty@file:vendor/node-pty`（`resolution: {directory: vendor/node-pty}`）并安装成功。

**根因候选（rc.41 修复函数提前退出路径，已全部在 rc.42 加固）**：
1. `const runtimePtyDir = join(app.getPath('userData'), 'host', 'node_modules', 'node-pty')` —— 若该路径不存在 → 原先**直接 `return`**。rc.42：不再因 runtime 缺失放弃，回退到任意 profile 已存在的 `vendor/node-pty` 作为源（跨 profile 自愈）。
   - 注意：`app.getPath('userData')` 在打包应用 = `%APPDATA%\@deepseek-ai\dsh-desktop`（从 user agent `@deepseek-ai/dsh-desktop/0.1.0-rc.41` 推断）。
2. 读 `runtimePtyDir/package.json` 失败 / version 非 string → 原先 `return`。rc.42：同样走兄弟 profile 兜底。
3. **vendor 复制（`cpSync`）抛异常 → 原先 `continue`，跳过本 profile 的 YAML 改写**（最可疑：vendor 复制失败会连 override 都不改）。rc.42：**复制失败不再跳过** YAML 改写——override 是持久目标态，先写对，vendor 复制留到下次 boot 幂等重试。
4. YAML 改写失败 → 原先 catch 静默。rc.42：全部关键决策/失败都写 `repair.log`。

**远程定位方式（rc.42 起，无需再跑诊断 bat）**：
- 用户机器正常启动一次 app（让 boot 跑过修复函数），把 `%APPDATA%\@deepseek-ai\dsh-desktop\repair.log` 发回即可。
- repair.log 会明确给出：runtime 目录是否存在及版本、最终采用的复制源、每个 profile 的 vendor 复制结果（OK/失败原因）、YAML 是否被改写。
- 若 repair.log 显示 `no node-pty source anywhere` → runtime 没解压出 node-pty（检查 runtime 版本/下载完整性）；若显示 `vendor COPY FAILED` → 重点查杀软/磁盘占用对 `cpSync` 的拦截。

## 五、诊断方法

0. **直接看 repair.log（rc.42 起）**：用户机器正常启动一次 app，读 `%APPDATA%\@deepseek-ai\dsh-desktop\repair.log`（带时间戳追加，含 runtime 目录/版本、复制源、每 profile vendor 结果、YAML 改写结果）。
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

- [x] 修复 `repairProfileNodePtyOverrides` 的提前退出路径（rc.42）：vendor 复制失败**不再跳过** YAML 改写；runtime 缺失时回退到兄弟 profile 已 materialized 的 vendor（跨 profile 自愈）
- [x] 加**落盘日志** `%APPDATA%\@deepseek-ai\dsh-desktop\repair.log`（`appendRepairLog`，带时间戳追加），修复函数所有决策点/失败点都写日志，用户机器无需跑诊断 bat 即可远程定位
- [x] **更新流程优化**：手动「检查更新」已改为串行（`checkUpdatesSerial`，先 `checkAppUpdate(true)`，仅 `none` 再 `checkRuntimeForUpdates()`），避免壳层 + runtime 并行下载/弹窗
- [x] **runtime 打包自愈（rc.43）**：`scripts/stage-runtime.ts` 新增 `repairBrokenPackageEntries()` —— deploy 后校验所有包入口（含扩展名解析），缺失入口的包从 npm registry 重取 tarball 覆盖，杜绝缺 lib 的坏包进 runtime
- [x] 重新发布 rc.43（已上传 Gitee stable：`DeepSeek-Harness-0.1.0-rc.43-x64.exe` + `dsh-runtime-0.1.0-rc.43-93efaf75c29e.zip`，运行时完整）
- [ ] 请用户更新到 rc.43，查看 `%APPDATA%\@deepseek-ai\dsh-desktop\repair.log` 并重装 `DSH-better-sidebar` 验证安装成功
- [ ] 收尾清理：桌面调试脚本（`修复DSH插件node-pty.bat`、`DSH_node-pty诊断.bat`）可留作离线兜底

## 七、相关代码位置

- `src/main.ts`
  - `repairProfileNodePtyOverrides()`（L796）—— 本次修复核心（rc.42 加固：落盘日志 + vendor 复制失败不跳过 YAML + 兄弟 profile 兜底）
  - `appendRepairLog()`（L766）—— 落盘日志（`userData/repair.log`）
  - `ensureYamlBlockEntry()`（L724）—— YAML 块注入/幂等
  - `repairProfileAllowBuildsPlaceholders()`（L677）—— 修 pnpm `set this to true or false` 占位 bug
  - `checkUpdatesSerial()`（L1656）—— 手动「检查更新」串行入口（先壳层，`none` 再 runtime）
  - `boot()` 调用点（约 L1819，在 `ensurePnpmEnvironment` 之后、市场挂载之前）
- `src/updater.ts` —— `checkAppUpdate` / `setupAutoUpdater`（壳层更新）
- `src/runtime-bootstrap.ts` —— runtime manifest 版本检测/下载
- `scripts/stage-runtime.ts`
  - `repairBrokenPackageEntries()`（rc.43）—— deploy 后校验包入口，缺失从 registry 重取（`entryExists` 支持无扩展名 main）
  - `packageEntry()` / `entryExists()` —— 入口解析与存在性判断（含扩展名推断）

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
