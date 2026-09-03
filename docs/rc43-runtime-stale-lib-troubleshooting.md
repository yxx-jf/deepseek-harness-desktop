# rc.43 首启崩溃排查记录（已解决 · 2026-09-03）

> 状态：**已解决** — rc.44 已从干净 workspace 重建 runtime 并发布，验证无旧符号。
> 更新时间：2026-09-03

## 一、问题现象

本机/用户验证 rc.43 时，启动即崩（`desktop Host exited before readiness (code 1)`）：

```
Error: failed to import loader entry typert-gateway
(@deepseek-ai/dsh-api-gateway): The requested module
'@deepseek-ai/dsh-typert-protocol' does not provide an export named
'TypertLookupFailure'

Error: failed to import loader entry subagent-spawn-in-process
(@deepseek-ai/dsh-subagent-spawn-in-process): The requested module
'@deepseek-ai/dsh-system-prompt' does not provide an export named
'FIRST_PARTY_SECTION_ORDER'
```

即：`dsh-api-gateway` / `dsh-subagent-*` 的 lib 需要 `dsh-typert-protocol` / `dsh-system-prompt` 导出 `TypertLookupFailure` / `FIRST_PARTY_SECTION_ORDER`，但目标包不导出。

## 二、根因（已确认）

1. **`FIRST_PARTY_SECTION_ORDER`、`TypertLookupFailure` 在 git 源码中根本不存在**：
   - `git -C upstream grep 'FIRST_PARTY_SECTION_ORDER' -- '*.ts'` → **无结果**
   - `git -C upstream grep 'TypertLookupFailure' -- '*.ts'` → **无结果**
   - 说明这些符号是**旧构建产物（lib/）里的残留**，当前源码已移除/改名。
2. **上一轮修复引入了旧 lib**：为补 runtime 缺 lib，用 `recover-libs.mjs`（已删除）从 **runtime-host（旧构建产物）复制了 232 个包的 lib 回 workspace**，覆盖了 `tsc` 重新生成的 `lib/types`。runtime-host 本身是旧的 → 旧 lib（含旧符号）被回灌 → 重新 stage 打包 rc.43 → 崩溃。
3. **根本问题：workspace 的构建产物（lib/）与 git 源码不同步**。lib 是"旧的"，源码是"新的"。

> ⚠️ **关键教训：绝不能用 runtime-host 的旧 lib 回灌 workspace。** 必须从当前 git 源码全量重建 lib/。

## 三、关键事实（供继续排查）

- `dsh-system-prompt`（`packages/core/system-prompt`）：在 `tsconfig.host.json` 里（host: True）；`src` 里无 `FIRST_PARTY_SECTION_ORDER`；`lib/index.js` 与 `lib/types/index.js` 均无该导出。
- `dsh-typert-protocol`：不在 `tsconfig.host.json` / `tsconfig.client.json` 的 references 直接列出（需确认其构建归属，可能被其它包的 references 间接引用；`tsc -b` 会沿 references 图构建）。
- `dsh`（apps/cli）在 `tsconfig.host.json` 里；`tsc -b tsconfig.host.json --force` 已能生成 `apps/cli/lib/types/bin.js`。
- `tsdown --filter <包名>` 单包构建可用（能生成 lib/index.js，绕开全量 workspace 构建；实测 session-turn-outline / util-time / util-values / experimental-code-runtime-python 均成功）。
- 全量 `tsdown --env.DSH_BUILD_FACE host` 在 Windows 会触发 `pnpm install` 依赖检查 → libuv 崩溃（`0xC0000142` / `UV_HANDLE_CLOSING`），需先确保 workspace node_modules 与 lockfile 一致。
- `runtime/package.json` 是 `generate-runtime-manifest.ts` 生成的 deploy manifest；stage 时自动重生成（**该文件 diff 是生成物，还原即可**）。
- 之前删除的 4 个"无 package.json 残留目录"备份在 `$env:TEMP\dsh-upstream-stale`（`code-runtime-python`、`agent-spine-demo`、`session-persistence-sqlite`、`tool-subagent-report`），它们**不应**出现在 workspace（会导致 pnpm/tsdown 解析异常）。
- `vendor/cordis`、`vendor/include` 的 package.json 曾被误删（git 显示 D），已 `git checkout -- vendor/cordis vendor/include` 恢复。

## 四、实际解决过程（rc.44）

**关键认知修正**：本地 workspace 的 lib **本来就是干净的**（从 git 源码构建），真正坏的是**发布到 Gitee 的 rc.43 runtime**（旧 lib 回灌后打包）。修复 = 从干净 workspace **强制重建 runtime** 再发布。

1. 核实 rc.43 runtime（`dsh-runtime-0.1.0-rc.43-93efaf75c29e.zip`）扫描：`dsh-api-gateway`（TypertLookupFailure）、`dsh-client-ui-deliverables`、`dsh-file-reference-local`、`dsh-subagent-in-process-driver`（FIRST_PARTY_SECTION_ORDER）4 个包 lib 带旧符号。
2. 核实本地 workspace 全量 lib（361 个 index.js）**0 个旧符号** → 本地源码/构建是干净的。
3. `pnpm install --offline --frozen-lockfile` 修 workspace 链接（@deepseek-ai 目录曾只剩 2 个链接；pnpm 认为 Already up to date 未重建链接，但 stage 的 `restoreLegacyHoists` 会从源码树兜底，不影响）。
4. 强制重新 stage：`node --import tsx scripts/stage-runtime.ts --force` → 新指纹 `bf9eec5ce294`，runtime-host 全量扫描 **0 个旧符号**。
5. 核对 runtime-host 关键文件完整（dsh/bin.js、web-frontend/index.html、node-pty prebuilds、dshmarket、4 个坏包已净）。
6. bump `package.json` → `0.1.0-rc.44`。
7. **发布时踩坑**：electron-builder 默认尝试自动 publish 到 GitHub（`build.publish` 配 github provider），需 `GH_TOKEN` → 报错。修复：`dist:thin` 脚本加 `electron-builder --win nsis --publish never`（发布永远走 Gitee 的 `publish:gitee`，不用 GitHub）。
8. `pnpm run dist:thin`（--publish never 生成 rc.44 产物 + latest.yml）→ `pnpm run publish:gitee` 上传 → 发布完成。
9. 验证：rc.44 runtime zip 0 个旧符号；Gitee runtime `0.1.0-rc.44-bf9eec5ce294`、shell `0.1.0-rc.44`。

## 五、相关代码位置

- `scripts/stage-runtime.ts`：`repairBrokenPackageEntries()`（deploy 后自愈校验缺入口包）、`packageEntry()` / `entryExists()`、`STAGE_CACHE_VERSION`（bump 强制重 build）
- `scripts/publish-runtime.ts`：runtime 打包/发布（thin-shell runtime → Gitee stable）
- `src/main.ts`：node-pty 修复（`repairProfileNodePtyOverrides`、`appendRepairLog`）、`checkUpdatesSerial`（检查更新串行）
- `package.json`：`dist:thin` 已加 `--publish never`
- `docs/node-pty-troubleshooting.md`：node-pty 修复全程记录（含 runtime 打包缺 lib 的根因）

## 六、待办清单

- [x] 核实 rc.43 runtime 坏包范围（4 个：api-gateway / client-ui-deliverables / file-reference-local / subagent-in-process-driver）
- [x] 确认本地 workspace lib 干净（361 包 0 旧符号）
- [x] 强制重新 stage（`--force`）→ 新指纹 bf9eec5ce294，runtime-host 无旧符号
- [x] bump rc.44 + 修复 `--publish never` + 发布到 Gitee
- [x] 验证 rc.44 zip 无旧符号 + Gitee 发布核对
- [ ] 让用户那台机器更新到 rc.44，验证启动 + 装 `DSH-better-sidebar`（看 `%APPDATA%\@deepseek-ai\dsh-desktop\repair.log`）
