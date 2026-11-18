import 'dotenv/config'
import { loadConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { createShutdown, installSignalHandlers } from '../lib/shutdown.js'
import { buildApp } from './app.js'

const config = loadConfig()
const pool = createPool(config.databaseUrl)
const { app, markShuttingDown } = buildApp({ pool })

const shutdown = createShutdown({
  graceMs: config.shutdownGraceMs,
  log: (msg) => app.log.info(msg),
})

// Registered first, closed last.
shutdown.add('postgres pool', () => pool.end())
shutdown.add('http server (drain in-flight requests)', () => app.close())
shutdown.add('mark not ready', markShuttingDown)

installSignalHandlers(shutdown)

await app.listen({ port: config.port, host: '0.0.0.0' })
