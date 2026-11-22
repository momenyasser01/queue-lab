import 'dotenv/config'
import { loadConfig } from '../config.js'
import { createPool } from './pool.js'
import { runMigrations } from './migrate.js'

const pool = createPool(loadConfig().databaseUrl)
try {
  const applied = await runMigrations(pool)
  console.log(
    applied.length
      ? `applied: ${applied.join(', ')}`
      : 'database is up to date',
  )
} catch (err) {
  console.error(err)
  process.exitCode = 1
} finally {
  await pool.end()
}
