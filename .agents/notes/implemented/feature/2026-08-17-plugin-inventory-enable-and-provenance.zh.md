# Agent Note：插件列表新增启停与来源标识

Status: implemented

[English](2026-08-17-plugin-inventory-enable-and-provenance.md) | 中文

## 问题

设置 → 插件列表原本是只读的状态看板：每张卡片只显示有效启用状态（已启用 / 已停用）、Loader 阶段与模块说明符。用户能看到插件开着，却无法关闭，无法得知它做什么（短名是唯一线索），也无法区分官方还是三方插件。

## 决策

库存条目新增三个事实与一个动作：

- **描述。** `list()` 通过 `createRequire` 从各条目自己的 `package.json` 解析 `description`（`cordis:` 内置插件无描述，渲染为空）。文案保留在插件包内，因此永远不会与插件本身脱节。
- **来源。** 模块说明符属于 harness 作用域（`@deepseek-ai/dsh-*`、`@deepseek-ai/cordis-*`、`cordis:` 内置）时 `origin` 为 `official`，否则为 `third-party`；在服务端判定，客户端只渲染普通徽标。
- **启停动作。** 新增 `setEnabled(entryId, enabled)` Remote，通过 Loader 自身的 `entry.update({ disabled: !enabled })` 更新 Cordis Entry：存活 fiber 立即启动或卸载，且在 loader 树有持久化后端时保存变更。组条目继续排除，与 `list()` 一致。`toggleable` 字段将 `cordis:` 内置插件标记为不可切换（它们始终必需）——服务端暴露 `toggleable: !entry.options.name.startsWith('cordis:')`，使客户端能隐藏必须保持启用的条目的开关。

卡片渲染来源徽标、描述（带“暂无描述”回退）以及一个 `role="switch"` 控件，翻转条目后刷新快照；切换失败显示“切换失败”而不是静默回退。不可切换的条目完全省略开关。

**中文描述。** 静态 `CHINESE_DESCRIPTIONS` 映射（`chinese-descriptions.ts`）覆盖全部 196 个官方插件的中文描述。映射以插件名（不含 `@deepseek-ai/dsh-` 前缀）为键，先于 `package.json` 回退被查询，因此 `cordis:` 内置插件也带中文描述。超过一行的描述在悬停时显示浮动 tooltip（绝对定位、pointer-events: none、限宽 360px）。

## 备选方案

- **客户端判定来源。** 前缀规则简单，但描述仍需要服务端读取包元数据，因此来源与描述放在同一快照里，而不是把判定拆到两端。
- **内置一份精心维护的描述映射。** 硬编码约 160 个插件的表会随插件新增而腐化；读取各包自身描述保持唯一事实来源。
- **暴露原始 loader 开关而不是 Remote。** 设置页是 Host 的可信客户端，库存已通过同一 Remote 暴露 `list`；`setEnabled` 是对应的写操作。

## 后果

插件列表现在可以从界面启用或禁用（即时生效；loader 树有可写后端时持久），每张卡片解释插件用途，官方插件与三方插件在视觉上区分。`toggleable` 字段保护 `cordis:` 内置插件不被禁用。所有官方插件的中文描述可用，长描述悬停显示浮动 tooltip。`setEnabled` Remote 与新增条目字段由库存服务端 spec 与标签页组件 spec 覆盖；除新增的卡片元信息行外，原有只读渲染行为不变。
