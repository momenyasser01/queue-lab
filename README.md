# queue-lab

Benchmarking a hand-written PostgreSQL queue (`FOR UPDATE SKIP LOCKED`) against BullMQ + Redis behind one shared `JobQueue` interface. See [docs/system-design.md](docs/system-design.md).

Results coming.

## Stack

Node.js 24, TypeScript (functional style, no classes), Fastify, `pg`, BullMQ, Vitest.

## Getting started

```bash
pnpm install
cp .env.example .env
docker compose -f infra/compose.yaml --profile core up -d
pnpm db:migrate   # apply src/db/migrations/*.sql
pnpm dev:api      # or: pnpm dev:worker
```

## Scripts

`pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm format` · `pnpm db:migrate`

`pnpm test` needs Docker running: the database tests start a throwaway Postgres with Testcontainers.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/), `type(scope): subject`. Types: `feat fix docs test chore refactor perf ci bench`. Scopes: `queue pg bullmq worker api db infra bench`. Imperative, lowercase, at most 72 characters.
- **Branches:** short-lived, `type/short-description` (for example `feat/pg-queue-adapter`). `main` is always green.
- **Pull requests:** one per slice of work, titled like a commit, squash-merged. CI must pass.
