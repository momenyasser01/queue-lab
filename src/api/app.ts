import Fastify from 'fastify'
import type { Pool } from '../db/pool.js'

type Deps = {
  pool: Pick<Pool, 'query'>
  logger?: boolean
}

export const buildApp = ({ pool, logger = true }: Deps) => {
  const app = Fastify({ logger })
  let shuttingDown = false

  // Liveness: the process is up.
  app.get('/healthz', async () => ({ status: 'ok' }))

  // Readiness: can take traffic. 503 while shutting down or when Postgres is unreachable.
  app.get('/readyz', async (_req, reply) => {
    if (shuttingDown) {
      return reply.code(503).send({ status: 'shutting_down' })
    }
    try {
      await pool.query('SELECT 1')
      return { status: 'ready' }
    } catch {
      return reply.code(503).send({ status: 'database_unavailable' })
    }
  })

  const markShuttingDown = () => {
    shuttingDown = true
  }

  return { app, markShuttingDown }
}
