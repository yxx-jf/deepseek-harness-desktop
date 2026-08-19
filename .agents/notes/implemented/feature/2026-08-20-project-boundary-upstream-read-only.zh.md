# Agent Note: 项目边界 — upstream 只读

状态：已实施

[English](2026-08-20-project-boundary-upstream-read-only.md) | 中文

## 规则（硬边界，不可违反）

- `upstream/` 目录是上游代码（deepseek-harness 上游仓库），**绝对不能修改其中任何文件**。
- 所有功能改动必须只落在桌面外壳自己的文件：`src/`、`resources/`、`scripts/`、`assets/`、`build/` 等。
- `upstream/` 下的文件可以读（用于理解架构），但不可写。

## 默认不碰 upstream

- 不要编辑 `upstream/**` 下的任何文件，除非用户在同一次请求中明确授权改动 upstream。
- 如果觉得某个 upstream 文件需要改，停下来问用户——几乎总有桌面端一侧的方案可以达到同样目的（IPC 桥接、preload 注入、主进程逻辑、`$DSH_HOME` 下的 patch 等）。

## 背景

- 桌面仓库（`deepseek-harness-desktop`）是上游 DSH Web Host 的套壳/包装。功能开发属于外壳，不属于上游克隆。
- 历史教训：agent 曾误改了 `upstream/packages/client/.../EmptyHero.tsx`，在被所有者纠正后还原。此处记录以防重犯。