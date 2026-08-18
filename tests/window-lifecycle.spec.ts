/** Unit tests for the desktop window and application lifetime. */

import { describe, expect, it, vi } from 'vitest'
import { createDesktopLifecycle, type DesktopLifecycleOptions, type DesktopWindow } from '../src/window-lifecycle.ts'

interface Harness {
  readonly lifecycle: ReturnType<typeof createDesktopLifecycle>
  readonly options: DesktopLifecycleOptions
  readonly window: DesktopWindow
  readonly getWindow: ReturnType<typeof vi.fn>
  readonly disposeHost: ReturnType<typeof vi.fn>
  readonly quit: ReturnType<typeof vi.fn>
  readonly createWindow: ReturnType<typeof vi.fn>
  readonly show: ReturnType<typeof vi.fn>
  readonly focus: ReturnType<typeof vi.fn>
  readonly hide: ReturnType<typeof vi.fn>
}

function makeHarness(visible = true): Harness {
  const show = vi.fn()
  const focus = vi.fn()
  const hide = vi.fn()
  const window: DesktopWindow = {
    isDestroyed: () => false,
    isVisible: () => visible,
    show,
    focus,
    hide,
  }
  const getWindow = vi.fn(() => window)
  const createWindow = vi.fn()
  const disposeHost = vi.fn().mockResolvedValue(undefined)
  const quit = vi.fn()
  const options: DesktopLifecycleOptions = {
    getWindow,
    createWindow,
    disposeHost,
    quit,
  }
  return { lifecycle: createDesktopLifecycle(options), options, window, getWindow, disposeHost, quit, createWindow, show, focus, hide }
}

function closeEvent(): { event: { preventDefault(): void }; preventDefault: ReturnType<typeof vi.fn> } {
  const preventDefault = vi.fn()
  return { event: { preventDefault }, preventDefault }
}

describe('createDesktopLifecycle window close', () => {
  it('hides a visible window without quitting', () => {
    const { lifecycle, disposeHost, quit, hide } = makeHarness(true)
    const { event, preventDefault } = closeEvent()
    lifecycle.onWindowClose(event)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(1)
    expect(disposeHost).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    expect(lifecycle.isQuitting).toBe(false)
  })

  it('quits when a tray-hidden window is closed externally', async () => {
    const { lifecycle, disposeHost, quit, hide } = makeHarness(false)
    const { event, preventDefault } = closeEvent()
    lifecycle.onWindowClose(event)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(hide).not.toHaveBeenCalled()
    expect(lifecycle.pendingQuit).toBeDefined()
    await lifecycle.pendingQuit
    expect(disposeHost).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('lets closes proceed during explicit quit', async () => {
    const { lifecycle, disposeHost, quit, hide } = makeHarness(true)
    await lifecycle.requestQuit()
    const { event, preventDefault } = closeEvent()
    lifecycle.onWindowClose(event)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
    expect(disposeHost).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('does not quit twice when a hidden window closes during quitting', async () => {
    const { lifecycle, disposeHost, quit, hide } = makeHarness(false)
    await lifecycle.requestQuit()
    lifecycle.onWindowClose(closeEvent().event)
    expect(hide).not.toHaveBeenCalled()
    expect(disposeHost).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })
})

describe('createDesktopLifecycle showWindow', () => {
  it('shows and focuses an existing hidden window', async () => {
    const { lifecycle, show, focus } = makeHarness(false)
    await lifecycle.showWindow()
    expect(show).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('recreates a destroyed window', async () => {
    const destroyedShow = vi.fn()
    const destroyedFocus = vi.fn()
    const destroyedHide = vi.fn()
    const destroyed: DesktopWindow = {
      isDestroyed: () => true,
      isVisible: () => false,
      show: destroyedShow,
      focus: destroyedFocus,
      hide: destroyedHide,
    }
    const replacementShow = vi.fn()
    const replacementFocus = vi.fn()
    const replacementHide = vi.fn()
    const replacement: DesktopWindow = {
      isDestroyed: () => false,
      isVisible: () => false,
      show: replacementShow,
      focus: replacementFocus,
      hide: replacementHide,
    }
    const { options, lifecycle } = makeHarness(true)
    vi.mocked(options.getWindow).mockReturnValue(destroyed)
    const createWindow = vi.mocked(options.createWindow).mockResolvedValue(replacement)
    await lifecycle.showWindow()
    expect(createWindow).toHaveBeenCalledTimes(1)
    expect(replacementShow).toHaveBeenCalledTimes(1)
    expect(replacementFocus).toHaveBeenCalledTimes(1)
  })
})
