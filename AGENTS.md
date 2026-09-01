# AGENTS.md — 本项目开发铁律（每次生成代码前必读）

这是一个 Electron 桌面壳仓库（deepseek-harness-desktop），加载本地构建的 `dsh web` Host。完整注意事项见 skill：**deepseek-harness-desktop**。

## 必须遵守

1. **绝不修改 `upstream/` 目录**（从 GitHub 克隆的上游 monorepo，改动会被覆盖、其他仓库同步不到）。一切定制写在本地：`src/main.ts` 注入 JS、`resources/`。

2. **注入 JS 是纯 JavaScript**：`src/main.ts` 的 `did-finish-load` 注入代码会被原样打包进模板字符串由渲染进程执行——禁止 TS 类型标注（如 `let x: Node | null`，会导致整段 SyntaxError 且被 `.catch(()=>{})` 静默吞掉）、禁止反引号。

3. **改页面文案只改文本、不动样式**：禁止 `el.textContent = ...`（销毁子节点、改字体样式）；用 `document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)` 只改叶子文本节点 `textNode.nodeValue`，再挂 `MutationObserver` 兜底 React 重渲染。

4. **窗口标题已硬编码为 `DeepSeek Harness`**（`APP_NAME`，`createMainWindow` 全路径锁定），不要移除。

## 常用命令

```sh
pnpm install                 # 根依赖
pnpm run prepare:upstream    # 克隆+构建上游（首次）
pnpm run build:shell         # tsc + tsdown → lib/main.js
pnpm run dev                 # 重建壳层 + electron .
```
