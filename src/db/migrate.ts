import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from './pool.js'

// Same relative path from src/db (tsx) and dist/db (tsc does not copy .sql files).
export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../src/db/migrations/', import.meta.url),
)

// Any constant works; it only has to be the same for every runner.
const LOCK_KEY = 7_265_301

/**
 * Applies every `*.sql` file in `dir` that is not yet in `schema_migrations`,
 * in name order. Each file and its bookkeeping row commit together, and an
 * advisory lock stops two runners from applying the same file at once.
 * Returns the names of the files it applied.
 */
export const runMigrations = async (
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> => {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    )
    const done = new Set(rows.map((r) => r.name))

    const applied: string[] = []
    for (const file of files.filter((f) => !done.has(f))) {
      const sql = await readFile(join(dir, file), 'utf8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
          file,
        ])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, {
          cause: err,
        })
      }
      applied.push(file)
    }
    return applied
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
      .catch(() => {})
    client.release()
  }
}
