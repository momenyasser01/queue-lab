export type Closer = () => Promise<void> | void

export type Shutdown = {
  /** Register a step. Steps run in reverse order of registration. */
  add: (name: string, close: Closer) => void
  /** Run all steps once; later calls return the same promise. */
  run: (reason: string) => Promise<void>
}

type ShutdownOptions = {
  graceMs: number
  log?: (message: string) => void
  /** Injectable so tests do not kill the process. */
  exit?: (code: number) => void
}

export const createShutdown = ({
  graceMs,
  log = console.log,
  exit = process.exit,
}: ShutdownOptions): Shutdown => {
  const steps: Array<{ name: string; close: Closer }> = []
  let running: Promise<void> | undefined

  const execute = async (reason: string) => {
    log(`shutdown: ${reason}`)

    // Hard stop if closing takes longer than the grace period.
    const timer = setTimeout(() => {
      log(`shutdown: grace period of ${graceMs}ms exceeded, forcing exit`)
      exit(1)
    }, graceMs)
    timer.unref()

    let failed = false
    for (const { name, close } of [...steps].reverse()) {
      try {
        await close()
        log(`shutdown: ${name} done`)
      } catch (err) {
        failed = true
        log(`shutdown: ${name} failed: ${String(err)}`)
      }
    }

    clearTimeout(timer)
    exit(failed ? 1 : 0)
  }

  return {
    add: (name, close) => {
      steps.push({ name, close })
    },
    run: (reason) => (running ??= execute(reason)),
  }
}

/** Wire process signals and fatal errors to the shutdown. */
export const installSignalHandlers = (
  shutdown: Shutdown,
  proc: NodeJS.Process = process,
) => {
  proc.on('SIGTERM', () => void shutdown.run('SIGTERM'))
  proc.on('SIGINT', () => void shutdown.run('SIGINT'))
  proc.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection', reason)
    void shutdown.run('unhandledRejection')
  })
  proc.on('uncaughtException', (err) => {
    console.error('uncaught exception', err)
    void shutdown.run('uncaughtException')
  })
}
