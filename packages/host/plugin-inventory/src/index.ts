/** Read-only projection of the current Cordis Loader plugin entries. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from './types.ts'
import { CHINESE_DESCRIPTIONS } from './chinese-descriptions.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Unscoped module key (e.g. `dsh-llm` for `@deepseek-ai/dsh-llm`). */
function pluginKey(name: string): string {
  return name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
}

/** Whether a module specifier names the official harness scope. */
function pluginOrigin(moduleName: string): PluginInventoryEntry['origin'] {
  return moduleName.startsWith('@deepseek-ai/dsh-')
    || moduleName.startsWith('@deepseek-ai/cordis-')
    || moduleName.startsWith('cordis:')
    ? 'official'
    : 'third-party'
}

/** Read a plugin description, preferring the Chinese map; `cordis:` built-ins carry descriptions there. */
function packageDescription(name: string): string {
  const key = pluginKey(name)
  const zh = CHINESE_DESCRIPTIONS[key]
  if (zh !== undefined) return zh
  if (name.startsWith('cordis:')) return ''
  try {
    const pkgPath = createRequire(import.meta.url).resolve(`${name}/package.json`)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { description?: unknown }
    return typeof pkg.description === 'string' ? pkg.description : ''
  } catch {
    return ''
  }
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   * @returns Current non-group Loader entries in Loader order.
   */
  @Remote('list')
  list(): PluginInventorySnapshot {
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
        description: packageDescription(entry.options.name),
        origin: pluginOrigin(entry.options.name),
      })
    }
    return { entries }
  }

  /**
   * Enable or disable one Loader entry for this session. The change applies
   * immediately through the entry's live fiber (start or dispose) and is
   * persisted by the owning loader tree when it has a durable backing store.
   * @param entryId - Loader-tree id of the target entry.
   * @param enabled - Target enablement state.
   */
  @Remote('setEnabled')
  async setEnabled(entryId: PluginEntryId, enabled: boolean): Promise<void> {
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      if (pluginEntryId(entry.id) !== entryId) continue
      await entry.update({ disabled: !enabled })
      // Persist to the owning loader tree. Include (cordis.yml) trees write
      // back to the file; the root Loader tree is in-memory only (no-op).
      entry.parent.tree.write()
      return
    }
    throw new Error(`plugin entry not found: ${entryId}`)
  }
}

export default PluginInventoryGateway
