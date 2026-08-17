# Agent Note: Plugin inventory gains enablement and provenance

Status: implemented

English | [中文](2026-08-17-plugin-inventory-enable-and-provenance.zh.md)

## Problem

The Settings → Plugins inventory was a read-only status board: every card showed only the effective enablement (`已启用` / `已停用`), the Loader phase, and the module specifier. A user could tell that a plugin was on but could not turn it off, could not tell what it did (the short name is the only hint), and could not tell whether a plugin was official or third-party.

## Decision

The inventory entry grows three facts and one action:

- **Description.** `list()` resolves each entry's package `description` from its `package.json` through `createRequire` (`cordis:` built-ins carry none and render an empty description). The copy stays in the package, so it is never out of sync with the plugin itself.
- **Provenance.** `origin` is `official` for module specifiers in the harness scope (`@deepseek-ai/dsh-*`, `@deepseek-ai/cordis-*`, `cordis:` built-ins) and `third-party` otherwise, decided server-side so the client renders a plain badge.
- **Enablement action.** A new `setEnabled(entryId, enabled)` Remote updates the Cordis `Entry` through the loader's own `entry.update({ disabled: !enabled })`: the live fiber starts or disposes immediately, and the owning loader tree persists the change when it has a durable backing store. Group entries stay excluded, matching `list()`. The `toggleable` field marks `cordis:` built-ins as non-toggleable (they are always required) — the server exposes `toggleable: !entry.options.name.startsWith('cordis:')` so the client can hide the switch for entries that must stay enabled.

The card renders a provenance badge, the description (with a `暂无描述` fallback), and a `role="switch"` control that flips the entry and refreshes the snapshot; a failed toggle surfaces `切换失败` instead of silently reverting. Non-toggleable entries omit the switch entirely.

**Chinese descriptions.** A static `CHINESE_DESCRIPTIONS` map (`chinese-descriptions.ts`) covers all 196 official harness plugins with Chinese descriptions. The map is keyed by plugin name (without `@deepseek-ai/dsh-` prefix) and is consulted before the `package.json` fallback, so `cordis:` built-ins also carry Chinese descriptions. Description text longer than one line shows a floating tooltip on hover (absolute-positioned, pointer-events: none, clipped to 360px width).

## Alternatives considered

- **Deciding provenance in the client.** The prefix rule is simple, but description still needs the server to read package metadata, so provenance lives beside it in the same snapshot instead of splitting the decision across two sides.
- **Shipping a curated description map.** A hard-coded table over ~160 plugins rots as plugins are added; reading each package's own description keeps one source of truth.
- **Exposing the raw loader toggle instead of a Remote.** The Settings tab is a trusted client of the Host, and the inventory already exposes `list` through the same Remote; `setEnabled` is the matching write.

## Consequences

Plugins in the inventory can now be enabled or disabled from the UI with immediate effect (and durable when the loader tree has a writable backing store), each card explains the plugin's purpose, and official plugins are visually distinct from third-party ones. `cordis:` built-ins are protected from disablement by the `toggleable` field. Descriptions are available in Chinese for all official plugins, and long descriptions show a floating tooltip on hover. The `setEnabled` Remote and the new entry fields are covered by the inventory server spec and the tab's component spec; the existing read-only rendering behavior is unchanged except for the added card meta row.
