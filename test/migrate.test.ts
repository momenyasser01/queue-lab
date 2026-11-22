import { readdir } from 'node:fs/promises'
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createPool, type Pool } from '../src/db/pool.js'
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.js'

// Same major version as infra/compose.yaml.
const IMAGE = 'postgres:17'

let container: StartedPostgreSqlContainer
let pool: Pool

beforeAll(async () => {
  container = await new PostgreSqlContainer(IMAGE).start()
  pool = createPool(container.getConnectionUri())
}, 120_000)

afterAll(async () => {
  await pool?.end()
  await container?.stop()
})

const allFiles = async () =>
  (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

describe('runMigrations', () => {
  test('applies every migration to an empty database', async () => {
    expect(await runMigrations(pool)).toEqual(await allFiles())

    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'queue_jobs' ORDER BY indexname`,
    )
    expect(rows.map((r) => r.indexname)).toEqual([
      'queue_jobs_fetch',
      'queue_jobs_idem',
      'queue_jobs_lease',
      'queue_jobs_pkey',
    ])
  })

  test('a second run applies nothing', async () => {
    expect(await runMigrations(pool)).toEqual([])
    const { rows } = await pool.query('SELECT name FROM schema_migrations')
    expect(rows).toHaveLength((await allFiles()).length)
  })

  test('concurrent runners apply each migration exactly once', async () => {
    await pool.query('CREATE DATABASE race')
    const racePool = createPool(
      container.getConnectionUri().replace(/\/[^/]+$/, '/race'),
    )
    try {
      const [a, b] = await Promise.all([
        runMigrations(racePool),
        runMigrations(racePool),
      ])
      expect([...a, ...b].sort()).toEqual(await allFiles())
    } finally {
      await racePool.end()
    }
  })
})

describe('queue_jobs', () => {
  test('a new job gets the queued defaults', async () => {
    const { rows } = await pool.query(
      `INSERT INTO queue_jobs (job_type, payload)
       VALUES ('noop', '{}')
       RETURNING status, attempts, max_attempts, run_at <= now() AS due`,
    )
    expect(rows[0]).toEqual({
      status: 'queued',
      attempts: 0,
      max_attempts: 3,
      due: true,
    })
  })

  test('ids are assigned in insert order', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO queue_jobs (job_type, payload)
       VALUES ('noop', '{"n":1}'), ('noop', '{"n":2}')
       RETURNING id`,
    )
    expect(BigInt(rows[1].id)).toBeGreaterThan(BigInt(rows[0].id))
  })

  test('a duplicate idempotency key is rejected, a missing one is not', async () => {
    const insert = (key: string | null) =>
      pool.query(
        `INSERT INTO queue_jobs (job_type, payload, idempotency_key) VALUES ('probe', '{}', $1)`,
        [key],
      )
    await insert('probe:video-1')
    await expect(insert('probe:video-1')).rejects.toMatchObject({
      code: '23505', // unique_violation
    })
    await insert(null)
    await insert(null)
  })

  test('completed is not a stored status (completed jobs are deleted)', async () => {
    await expect(
      pool.query(
        `INSERT INTO queue_jobs (job_type, payload, status) VALUES ('noop', '{}', 'completed')`,
      ),
    ).rejects.toMatchObject({ code: '22P02' }) // invalid_text_representation
  })
})
