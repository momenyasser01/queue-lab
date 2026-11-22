# queue-lab

Benchmarking a hand-written PostgreSQL queue (`FOR UPDATE SKIP LOCKED`) against BullMQ + Redis behind one shared `JobQueue` interface. See [docs/system-design.md](docs/system-design.md).

Results coming.

## Stack

Node.js 24, TypeScript (functional style, no classes), Fastify, `pg`, BullMQ, Vitest.

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm infra:up     # Postgres + Redis from infra/compose.yaml, configured by .env
pnpm db:migrate   # apply src/db/migrations/*.sql
pnpm dev:api      # or: pnpm dev:worker
```

## Configuration

- **One file:** the repo-root `.env` configures both the app (read with `dotenv`) and Compose (`pnpm infra:up` passes `--env-file .env`). Keep `DATABASE_URL` in step with the `POSTGRES_*` values above it. Wrap a value that contains `$` in single quotes (`POSTGRES_PASSWORD='pa$$word'`): Compose otherwise treats `$name` as a variable and silently blanks it. In `DATABASE_URL`, percent-encode `@ : / # ? %` in the password.
- **Postgres settings apply once:** `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` are read only when the `pgdata` volume is first created. To change them later, run `pnpm infra:down`, then `docker volume rm queue-lab_pgdata` (this deletes the local data), then `pnpm infra:up`.
- **Port already in use:** if another Postgres listens on 5432 (for example a Windows service), set `POSTGRES_PORT=5433` and use `5433` in `DATABASE_URL`. If you skip this, `localhost:5432` may reach the other server and fail with `password authentication failed`.
- **Images:** `.env` is excluded by `.dockerignore`; containers get their settings from Compose when they start. The credentials here are throwaway local values. Real secrets would use Compose `secrets:` (for example `POSTGRES_PASSWORD_FILE`) instead of plain environment variables.

## Inspecting the database

The Postgres container publishes its port on your machine, so any client can connect to it.

- **psql:** `pnpm db:psql` opens psql inside the container, already logged in with the user and database from `.env`. Try `\dt` (list tables), `\d queue_jobs` (describe the table), then `\q` to leave:

  ```sql
  INSERT INTO queue_jobs (job_type, payload) VALUES ('noop', '{"hello": "world"}') RETURNING *;
  SELECT id, job_type, status, attempts, run_at FROM queue_jobs ORDER BY id;
  ```

- **pgAdmin 4 or another GUI:** register a server with host `localhost`, port `POSTGRES_PORT` (5432 by default), and the database, user and password from `.env` (`queuelab` by default). The tables are under the `public` schema.
- If another Postgres on this machine uses the same port, the GUI reaches that server instead and the login fails. Move this one with `POSTGRES_PORT` (see Configuration).

## Scripts

`pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm format` · `pnpm infra:up` · `pnpm infra:down` · `pnpm db:migrate` · `pnpm db:psql`

`pnpm test` needs Docker running: the database tests start a throwaway Postgres with Testcontainers.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), `type(scope): subject`. Types: `feat fix docs test chore refactor perf ci bench`. Scopes: `queue pg bullmq worker api db infra bench`. Imperative, lowercase, at most 72 characters.
- **Branches:** short-lived, `type/short-description` (for example `feat/pg-queue-adapter`). `main` is always green.
- **Pull requests:** one per slice of work, titled like a commit, squash-merged. CI must pass.
