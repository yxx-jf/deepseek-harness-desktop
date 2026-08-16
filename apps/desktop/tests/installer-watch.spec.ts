/** Unit tests for the NSIS installer watcher. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInstallerWatch, hasInstallerRow, type InstallerWatchOptions } from '../src/installer-watch.ts'

interface Harness {
  readonly watch: ReturnType<typeof createInstallerWatch>
  readonly isInstallerRunning: ReturnType<typeof vi.fn>
  readonly onInstallerDetected: ReturnType<typeof vi.fn>
}

function makeHarness(intervalMs = 10): Harness {
  const isInstallerRunning = vi.fn()
  const onInstallerDetected = vi.fn()
  const options: InstallerWatchOptions = { isInstallerRunning, onInstallerDetected, intervalMs }
  return { watch: createInstallerWatch(options), isInstallerRunning, onInstallerDetected }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('hasInstallerRow', () => {
  it('matches an installer CSV row', () => {
    expect(hasInstallerRow('"DeepSeek-Harness-0.1.0-rc.5-x64.exe","10820","Console","1","12345 K","Running"\r\n')).toBe(true)
    expect(hasInstallerRow('"DeepSeek-Harness-0.1.0-rc.6-arm64.exe","1","Console","1","1 K","Running"')).toBe(true)
  })

  it('rejects the tasklist no-match notice and empty output', () => {
    expect(hasInstallerRow('INFO: No tasks are running which match the specified criteria.\r\n')).toBe(false)
    expect(hasInstallerRow('')).toBe(false)
  })

  it('does not match the application or uninstaller image names', () => {
    expect(hasInstallerRow('"DeepSeek Harness.exe","1","Console","1","1 K","Running"')).toBe(false)
    expect(hasInstallerRow('"Uninstall DeepSeek Harness.exe","1","Console","1","1 K","Running"')).toBe(false)
  })
})

describe('createInstallerWatch', () => {
  it('polls until the installer is detected, then stops', () => {
    const { watch, isInstallerRunning, onInstallerDetected } = makeHarness()
    isInstallerRunning
      .mockImplementationOnce((callback: (running: boolean) => void) => { callback(false) })
      .mockImplementationOnce((callback: (running: boolean) => void) => { callback(true) })
    watch.start()
    expect(isInstallerRunning).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(isInstallerRunning).toHaveBeenCalledTimes(2)
    expect(onInstallerDetected).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)
    expect(isInstallerRunning).toHaveBeenCalledTimes(2)
  })

  it('keeps polling while the installer is absent', () => {
    const { watch, isInstallerRunning, onInstallerDetected } = makeHarness()
    isInstallerRunning.mockImplementation((callback: (running: boolean) => void) => { callback(false) })
    watch.start()
    vi.advanceTimersByTime(1_000)
    expect(isInstallerRunning.mock.calls.length).toBeGreaterThan(1)
    expect(onInstallerDetected).not.toHaveBeenCalled()
  })

  it('stop() halts polling', () => {
    const { watch, isInstallerRunning, onInstallerDetected } = makeHarness()
    isInstallerRunning.mockImplementation((callback: (running: boolean) => void) => { callback(false) })
    watch.start()
    watch.stop()
    const calls = isInstallerRunning.mock.calls.length
    vi.advanceTimersByTime(1_000)
    expect(isInstallerRunning.mock.calls.length).toBe(calls)
    expect(onInstallerDetected).not.toHaveBeenCalled()
  })

  it('stop() ignores an in-flight check result', () => {
    const { watch, isInstallerRunning, onInstallerDetected } = makeHarness()
    let captured: ((running: boolean) => void) | undefined
    isInstallerRunning.mockImplementation((callback: (running: boolean) => void) => { captured = callback })
    watch.start()
    watch.stop()
    captured?.(true)
    expect(onInstallerDetected).not.toHaveBeenCalled()
  })

  it('start() is idempotent', () => {
    const { watch, isInstallerRunning } = makeHarness()
    watch.start()
    watch.start()
    expect(isInstallerRunning).toHaveBeenCalledTimes(1)
  })
})
