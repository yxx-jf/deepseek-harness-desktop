/** Unit tests for the desktop Host supervisor. */

import { describe, expect, it, vi } from 'vitest'
import { createHostSupervisor, type HostChild } from '../src/host-supervisor.ts'

interface FakeHost {
  readonly child: HostChild
  readonly kill: ReturnType<typeof vi.fn>
  emitStdout(chunk: string): void
  emitStderr(chunk: string): void
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void
}

function fakeHost(): FakeHost {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const stderrListeners: Array<(chunk: string) => void> = []
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const kill = vi.fn()
  const child: HostChild = {
    pid: 4242,
    stdout: { onData: (listener) => { stdoutListeners.push(listener); return () => {} } },
    stderr: { onData: (listener) => { stderrListeners.push(listener); return () => {} } },
    onExit: (listener) => { exitListeners.push(listener); return () => {} },
    onError: () => () => {},
    kill,
  }
  return {
    child,
    kill,
    emitStdout: (chunk) => { for (const listener of stdoutListeners) listener(chunk) },
    emitStderr: (chunk) => { for (const listener of stderrListeners) listener(chunk) },
    emitExit: (code, signal = null) => { for (const listener of exitListeners) listener(code, signal) },
  }
}

interface Harness {
  readonly supervisor: ReturnType<typeof createHostSupervisor>
  readonly host: FakeHost
  readonly log: ReturnType<typeof vi.fn>
  readonly onUnexpectedExit: ReturnType<typeof vi.fn>
}

function makeHarness(): Harness {
  const host = fakeHost()
  const log = vi.fn()
  const onUnexpectedExit = vi.fn()
  const supervisor = createHostSupervisor({
    spawnHost: () => host.child,
    log,
    onUnexpectedExit,
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
  })
  return { supervisor, host, log, onUnexpectedExit }
}

async function ready(harness: Harness): Promise<string> {
  const started = harness.supervisor.start()
  harness.host.emitStdout('dsh web: http://127.0.0.1:55123\n')
  return await started
}

describe('createHostSupervisor', () => {
  it('resolves with the loopback URL once the readiness line arrives', async () => {
    const harness = makeHarness()
    const started = harness.supervisor.start()
    harness.host.emitStdout('dsh web: http://127.0.0.1:55123\n')
    await expect(started).resolves.toBe('http://127.0.0.1:55123')
  })

  it('forwards Host stdout and stderr after readiness', async () => {
    const harness = makeHarness()
    await ready(harness)
    harness.host.emitStdout('host warning line\n')
    harness.host.emitStderr('host error line\n')
    expect(harness.log).toHaveBeenCalledWith('host warning line\n')
    expect(harness.log).toHaveBeenCalledWith('host error line\n')
  })

  it('keeps the resolved URL and forwards output when a later line resembles readiness', async () => {
    const harness = makeHarness()
    await expect(ready(harness)).resolves.toBe('http://127.0.0.1:55123')
    harness.host.emitStdout('dsh web: http://127.0.0.1:9999\n')
    expect(harness.log).toHaveBeenCalledWith('dsh web: http://127.0.0.1:9999\n')
  })

  it('reports an unexpected exit of a ready Host', async () => {
    const harness = makeHarness()
    await ready(harness)
    harness.host.emitExit(1)
    expect(harness.onUnexpectedExit).toHaveBeenCalledWith({ code: 1, signal: null })
  })

  it('does not report an expected shutdown exit', async () => {
    const harness = makeHarness()
    await ready(harness)
    const shuttingDown = harness.supervisor.shutdown()
    expect(harness.host.kill).toHaveBeenCalledWith('SIGTERM')
    harness.host.emitExit(0)
    await shuttingDown
    expect(harness.onUnexpectedExit).not.toHaveBeenCalled()
  })

  it('rejects when the Host exits before readiness', async () => {
    const harness = makeHarness()
    const started = harness.supervisor.start()
    harness.host.emitExit(7)
    await expect(started).rejects.toThrow(/exited before readiness/)
  })
})
