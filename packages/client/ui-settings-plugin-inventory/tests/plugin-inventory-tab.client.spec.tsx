// @vitest-environment jsdom
// PluginInventorySettingsTab behavior: provenance badge, description, and the
// per-entry enable switch drive the injected setEnabled and refresh the list.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { PluginInventorySettingsTab, type PluginInventorySettingsTabProps } from '../src/client/PluginInventorySettingsTab.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t: PluginInventorySettingsTabProps['t'] = makeTranslate(zh, commonZh)

// Global standard kit stubs: the inventory tab consumes neither hook.
const unusedHook = (() => { throw new Error('unused by the plugin inventory tab') }) as never
const kit = { useSessions: unusedHook, useWorkspaces: unusedHook }

type Entry = PluginInventorySnapshot['entries'][number]

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: 'e1' as Entry['entryId'],
    moduleName: '@deepseek-ai/dsh-llm',
    enabled: true,
    fiberPhase: 'active',
    description: 'LLM capability',
    origin: 'official',
    toggleable: true,
    ...overrides,
  }
}

function renderTab(list: () => Promise<PluginInventorySnapshot>, setEnabled: (id: Entry['entryId'], enabled: boolean) => Promise<void>) {
  return render(
    <PluginInventorySettingsTab
      {...kit}
      list={list}
      setEnabled={setEnabled}
      t={t}
    />,
  )
}

describe('PluginInventorySettingsTab', () => {
  it('shows the provenance badge, description, and an enable switch', async () => {
    renderTab(
      async () => ({ entries: [entry()] }),
      vi.fn(async () => {}),
    )
    expect(await screen.findByText('llm')).toBeTruthy()
    expect(screen.getByText('官方')).toBeTruthy()
    expect(screen.getByText('LLM capability')).toBeTruthy()
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('labels a third-party module and an absent description', async () => {
    renderTab(
      async () => ({ entries: [entry({ origin: 'third-party', description: '' })] }),
      vi.fn(async () => {}),
    )
    expect(await screen.findByText('三方')).toBeTruthy()
    expect(screen.getByText('暂无描述')).toBeTruthy()
  })

  it('calls setEnabled with the flipped state and refreshes the list', async () => {
    const setEnabled = vi.fn(async () => {})
    const list = vi.fn(async () => ({ entries: [entry()] }))
    renderTab(list, setEnabled)
    const toggle = await screen.findByRole('switch')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(setEnabled).toHaveBeenCalledWith('e1', false)
    })
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2)
    })
  })

  it('reports a failed toggle without refreshing', async () => {
    const setEnabled = vi.fn(async () => { throw new Error('boom') })
    const list = vi.fn(async () => ({ entries: [entry()] }))
    renderTab(list, setEnabled)
    const toggle = await screen.findByRole('switch')
    fireEvent.click(toggle)
    expect(await screen.findByText('切换失败，请重试。')).toBeTruthy()
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1)
    })
  })
})
