import pg from 'pg'

export type Pool = pg.Pool

export const createPool = (databaseUrl: string): Pool =>
  new pg.Pool({ connectionString: databaseUrl })
