import 'dotenv/config'
import { loadConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { buildApp } from '../api/app.js'
import { createShutdown, installSignalHandlers } from '../lib/shutdown.js'

const config = loadConfig()
const pool = createPool(config.databaseUrl)

// The worker serves the same /healthz + /readyz pair (metrics come later).
const { app, markShuttingDown } = buildApp({ pool })

const shutdown = createShutdown({
  graceMs: config.shutdownGraceMs,
  log: (msg) => app.log.info(msg),
})

// Closed in reverse order: not ready -> stop consumers (later) -> http -> pool.
shutdown.add('postgres pool', () => pool.end())
shutdown.add('http server', () => app.close())
// TODO(milestone 3): shutdown.add('consumers', () => consumer.stop(config.shutdownGraceMs))
shutdown.add('mark not ready', markShuttingDown)

installSignalHandlers(shutdown)

await app.listen({ port: config.port, host: '0.0.0.0' })
