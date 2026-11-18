export type QueueBackend = 'pg' | 'bullmq'

export type Config = Readonly<{
  port: number
  databaseUrl: string
  redisUrl: string
  queueBackend: QueueBackend
  shutdownGraceMs: number
}>

const toInt = (name: string, value: string | undefined, fallback: number) => {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${value}"`)
  }
  return n
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const queueBackend = env.QUEUE_BACKEND ?? 'pg'
  if (queueBackend !== 'pg' && queueBackend !== 'bullmq') {
    throw new Error(
      `QUEUE_BACKEND must be "pg" or "bullmq", got "${queueBackend}"`,
    )
  }

  return Object.freeze({
    port: toInt('PORT', env.PORT, 3000),
    databaseUrl,
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    queueBackend,
    shutdownGraceMs: toInt('SHUTDOWN_GRACE_MS', env.SHUTDOWN_GRACE_MS, 20000),
  })
}
