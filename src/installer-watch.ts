/** Detect the NSIS installer process and quit the application in response. */

/** Whether tasklist CSV output contains an installer row (no-match notices are not CSV). */
export function hasInstallerRow(stdout: string): boolean {
  return /^"DeepSeek-Harness/iu.test(stdout)
}

/** Polling controller that stops at the first positive detection. */
export interface InstallerWatch {
  /** Begin polling; a no-op once started. */
  start(): void
  /** Stop polling and ignore any in-flight check result. */
  stop(): void
}

/** Dependencies supplied by the Electron main process. */
export interface InstallerWatchOptions {
  /** Enumerate running processes and report whether the installer is present. */
  readonly isInstallerRunning: (callback: (running: boolean) => void) => void
  /** Called once, after polling stops, when the installer is detected. */
  readonly onInstallerDetected: () => void
  /** Milliseconds between polls; defaults to 3000. */
  readonly intervalMs?: number
}

/**
 * Create an installer detector.
 * @param options - Process check, detection callback and poll cadence.
 * @returns A watcher that polls until detection or an explicit stop.
 */
export function createInstallerWatch(options: InstallerWatchOptions): InstallerWatch {
  const intervalMs = options.intervalMs ?? 3_000
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let stopping = false

  const poll = (): void => {
    options.isInstallerRunning((running) => {
      if (stopping) return
      if (running) {
        stop()
        options.onInstallerDetected()
        return
      }
      timer = setTimeout(poll, intervalMs)
    })
  }

  const start = (): void => {
    if (started) return
    started = true
    stopping = false
    poll()
  }

  const stop = (): void => {
    stopping = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  return { start, stop }
}
