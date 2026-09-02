# rc.43 首启崩溃排查记录（未解决 · 2026-09-03 交接）

> 状态：**未解决** — rc.43 已发布但首启崩溃。根因已定位，明天在另一台电脑继续修复。
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

## 四、下一步计划（明天）

**核心：不能再用 runtime-host 的旧 lib，必须从当前 git 源码全量重建 workspace 的 lib/。**

1. 确认 workspace（upstream）node_modules 与 lockfile 一致（避免 pnpm install / tsdown 崩溃）：
   - 确认那 4 个残留目录不在 workspace（已在 temp 备份）。
   - 确认 `vendor/cordis`、`vendor/include` 的 package.json 完整。
2. 从 git 源码重建所有包的 lib/：
   ```sh
   cd upstream
   pnpm exec tsc -b tsconfig.host.json --force
   pnpm exec tsc -b tsconfig.client.json --force
   pnpm exec tsdown --env.DSH_BUILD_FACE host
   ```
   - 若 tsdown 全量仍触发 pnpm install 崩溃：先 `pnpm install --offline --child-concurrency=1` 修好 workspace 状态；或改用 `tsdown --filter <包名>` 逐包重建缺失/旧的包。
3. **验证**：确认 `dsh`（apps/cli）、`dsh-api-gateway`、`dsh-subagent-*` 等包的 `lib/types/index.js` **不再** import `FIRST_PARTY_SECTION_ORDER` / `TypertLookupFailure`（git grep 源码无这些符号即为目标态）。
4. 强制重新 stage（清掉旧 runtime-host 缓存）：
   ```sh
   node --import tsx scripts/stage-runtime.ts --force
   ```
5. 验证 runtime-host 里 `@deepseek-ai/dsh-system-prompt/lib/index.js`、`dsh-typert-protocol/lib/index.js` 与源码一致。
6. `package.json` version bump → rc.44 → `pnpm run release:gitee` 发布。
7. 本机/用户验证：更新到 rc.44，启动 + 装插件。

## 五、相关代码位置

- `scripts/stage-runtime.ts`：`repairBrokenPackageEntries()`（deploy 后自愈校验缺入口包）、`packageEntry()` / `entryExists()`、`STAGE_CACHE_VERSION`（bump 强制重 build）
- `scripts/publish-runtime.ts`：runtime 打包/发布（thin-shell runtime → Gitee stable）
- `src/main.ts`：node-pty 修复（`repairProfileNodePtyOverrides`、`appendRepairLog`）、`checkUpdatesSerial`（检查更新串行）
- `docs/node-pty-troubleshooting.md`：node-pty 修复全程记录（含 runtime 打包缺 lib 的根因）

## 六、待办清单

- [ ] 全量重建 workspace lib（tsc -b + tsdown），**不用 runtime-host 旧 lib**
- [ ] 验证 lib 与 git 源码一致（无旧符号 import）
- [ ] 强制重新 stage + 验证 runtime-host
- [ ] bump rc.44 + 发布
- [ ] 本机/用户验证（rc.44 启动 + 装插件）
