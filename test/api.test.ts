import { afterEach, expect, test } from 'vitest'
import { buildApp } from '../src/api/app.js'

const okPool = { query: async () => ({ rows: [] }) } as never
const brokenPool = {
  query: async () => {
    throw new Error('connection refused')
  },
} as never

let current: ReturnType<typeof buildApp> | undefined
afterEach(async () => {
  await current?.app.close()
})

const make = (pool: never) => (current = buildApp({ pool, logger: false }))

test('/healthz is always 200', async () => {
  const res = await make(brokenPool).app.inject('/healthz')
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ status: 'ok' })
})

test('/readyz is 200 when the database answers', async () => {
  const res = await make(okPool).app.inject('/readyz')
  expect(res.statusCode).toBe(200)
})

test('/readyz is 503 when the database fails', async () => {
  const res = await make(brokenPool).app.inject('/readyz')
  expect(res.statusCode).toBe(503)
})

test('/readyz is 503 after markShuttingDown', async () => {
  const { app, markShuttingDown } = make(okPool)
  markShuttingDown()
  const res = await app.inject('/readyz')
  expect(res.statusCode).toBe(503)
  expect(res.json()).toEqual({ status: 'shutting_down' })
})
