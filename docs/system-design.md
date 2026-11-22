# Queue Benchmark Transcoder — System Design

Nov 16, 2026 · updated Nov 18, 2026 · @mo

## Overview

One video-processing platform with two queue backends, chosen per run by `QUEUE_BACKEND`: PostgreSQL (`pg`) or BullMQ + Redis (`bullmq`). The API, job code, storage and workers are shared, so any difference in the results comes from the queue alone.

**The question it answers:** under which workloads does PostgreSQL-as-a-queue match BullMQ + Redis, and what does each cost in throughput, waiting time, crash recovery and operations?

| Backend  | How a worker takes a job                                                                                                | What happens if the worker crashes                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `pg`     | One SQL statement picks the next job with `FOR UPDATE SKIP LOCKED` and marks it `running` with a lease (`locked_until`) | A reaper puts jobs whose lease expired back in the queue |
| `bullmq` | BullMQ moves the job to `active` and holds a lock in Redis                                                              | BullMQ's stalled-job check puts it back                  |

**Scope.** The core deliverable is the `pg` vs `bullmq` comparison (build-order milestones 1–4, including the crash tests). The video pipeline and its object storage are a later milestone. A third `pg-txlock` variant (a transaction held open while the job runs) is out of scope and listed under future work.

**Design rules**

- At-least-once delivery: after a crash a job may run twice, so every job must be safe to repeat (idempotent).
- Every job gets a fixed ID such as `probe:{videoId}`, so the same job cannot be queued twice.
- The pipeline logic (what runs after what) lives in our code, not in BullMQ-only features, so both backends run identical logic.
- Jobs carry IDs and file paths, never video bytes.
- The Postgres queue is hand-written: plain tables and SQL using only built-in features (`FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY`). No queue extension (PgQ, pgmq) and no queue library (pg-boss, graphile-worker). The only library on that side is `pg`, the database driver.
- Every process exposes `/healthz` and `/metrics`.
- Stack: Node.js LTS + TypeScript, Fastify, `pg`, BullMQ, ffmpeg/ffprobe, object storage (SeaweedFS, pipeline milestone), Vitest, pnpm. Code style: functional, no classes.

## Video basics

You only need four terms to follow this doc.

| Term        | What it means                                                                                                                                              | Where it shows up here                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Transcoding | Converting a video to another resolution, format or quality by re-encoding every frame. CPU-heavy: minutes per video                                       | The `transcode` job runs ffmpeg                                          |
| Rendition   | One converted copy of the same video, such as the 720p version. Streaming sites keep several so the player can switch to match the viewer's internet speed | Each upload produces 3 (1080p, 720p, 480p), one row each in `renditions` |
| Probe       | Reading a video's metadata (length, width, height, codec) without converting it. Fast, usually under a second                                              | The `probe` job runs ffprobe; results go on the `videos` row             |
| Thumbnail   | One frame saved as an image, used as the preview picture                                                                                                   | The `thumbnail` job; its file path goes on the `videos` row              |

**One upload, step by step**

1. You upload `cat.mp4`. The API saves the file to SeaweedFS, creates a `videos` row with status `queued`, and queues a `probe` job.
2. A worker runs `probe` and saves the video's length and size.
3. `probe` then queues 4 jobs at once: 1 `thumbnail` and 3 `transcode` (1080p, 720p, 480p). Different workers run them in parallel.
4. When the last of the 3 transcodes finishes, the video becomes `ready`. The client finds out by asking `GET /videos/:id`.

The 3 renditions are there on purpose. One job creating several (fan-out) and waiting until all of them finish (fan-in) are the patterns real job systems use. They also give the queue several jobs per video to hand out at once, instead of one.

## System architecture

&#91;embedded content: system architecture · API, 3 workers, 3 stores, monitoring\]

Only one of the two highlighted stores is the queue in a run. Postgres always stores the app data, so in `pg` runs it does both jobs; that extra load is part of what gets measured. The load generator also puts synthetic jobs (tiers 1–2) straight into the queue; that line is left out to keep the picture readable.

## Components

Each worker is its own small server: it takes jobs from the queue and also answers HTTP requests for health checks and metrics.

| Component            | Runs as                                      | What it does                                                                                                                        | Talks to                       |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| API server           | Fastify, 1 container                         | Receives uploads and saves them to SeaweedFS, creates the `videos` row, queues the first job, answers status requests               | Postgres, the queue, SeaweedFS |
| Worker               | Node process, 3+ containers                  | Takes jobs, runs ffprobe/ffmpeg, saves outputs, queues the next jobs; serves `/healthz` and `/metrics`                              | The queue, Postgres, SeaweedFS |
| Reaper               | A timer inside every worker                  | `pg` only: puts jobs whose lease expired back in the queue. Safe to run in every worker at once because it is a single SQL `UPDATE` | Postgres                       |
| PostgreSQL           | 1 container                                  | App tables (`videos`, `renditions`) plus `queue_jobs` for the `pg` backend                                                          | —                              |
| Redis                | 1 container                                  | BullMQ's data                                                                                                                       | —                              |
| SeaweedFS            | 1 container                                  | Stores files: original uploads, renditions, thumbnails. It speaks the Amazon S3 API, so the same code would work on S3              | —                              |
| Load generator       | CLI container, run on demand                 | Runs workload tiers 1–4 and saves each run's results as a JSON file in `bench/results/`                                             | API, the queue                 |
| Prometheus + Grafana | 2 containers                                 | Collect every `/metrics` endpoint; show the dashboards                                                                              | All of the above               |
| Exporters            | postgres-exporter, redis\_exporter, cAdvisor | Turn Postgres, Redis and per-container CPU/memory stats into Prometheus metrics                                                     | Postgres, Redis, Docker        |

Prometheus finds every worker replica through Docker's DNS: the service name `worker` resolves to all replica IPs, so `dns_sd_configs` (type `A`) picks up `--scale worker=N` without config changes.

## Queue abstraction (functional style)

The code is functional TypeScript: no classes. A "interface" is a `type` that is an object of functions, an adapter is a factory function that closes over its dependencies and returns that object, and dependencies are passed as arguments (so tests pass plain fakes). Workers and the API depend only on the `JobQueue` type. One contract test suite runs against both adapters. The types live in `src/queue/types.ts`.

| Concept                                       | Shape                                                                                             | Notes                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `JobQueue`                                    | `{ enqueue(queue, payload, opts?, tx?), consume(queue, handler, opts?), counts(queue), close() }` | `consume` returns a `Consumer`                        |
| `Consumer`                                    | `{ start(), stop(graceMs) }`                                                                      |                                                       |
| `JobHandler<P>`                               | `{ queue, handle(ctx, payload) }`                                                                 | A plain object per job type                           |
| `JobContext`                                  | `{ jobId, attempt, enqueuedAt, signal, heartbeat(), enqueue(queue, payload, opts?) }`             | `signal` aborts ffmpeg on shutdown or lease loss      |
| `createPostgresQueue({ pool, leaseMs, ... })` | returns `JobQueue & { reapExpired() }`                                                            | Hand-written SQL, no `this`                           |
| `createBullMqQueue({ connection })`           | returns `JobQueue`                                                                                | Keeps its `Queue` instances in a closure `Map`        |
| `createWorker({ queue, handlers })`           | returns `{ start(), shutdown(signal) }`                                                           | Replaces `WorkerRuntime`                              |
| Media and storage (pipeline milestone)        | `createS3Storage(...)`, `createMedia(...)`                                                        | `ObjectStorage` and `Media` are function-object types |

```mermaid
flowchart LR
  W[createWorker] --> Q[JobQueue]
  W --> H[JobHandler objects]
  Q --- PG[createPostgresQueue]
  Q --- BQ[createBullMqQueue]
  H --> M[Media]
  H --> S[ObjectStorage]
```

**Saving to the database and queuing a job together is where the backends differ.** The optional `tx` lets `PostgresJobQueue` insert the job in the same transaction as the `videos` row, so both are saved or neither is. BullMQ cannot join a Postgres transaction, so `BullMqQueue` queues the job right after the commit. If the API crashes between those two steps, the video sits in `queued` with no job. A small sweeper re-queues videos stuck in `queued` for too long; the fixed job ID makes a repeat harmless. Mention this gap in the results: it is a real cost of the Redis option.
`NoopHandler` and `SleepHandler` exist only for workload tiers 1–2. `JobContext.signal` aborts ffmpeg (the child process is killed) on shutdown or lease loss.

## Database design

Three tables. `videos` and `renditions` hold the app's data and exist in both backends: one row per uploaded video, and one row per converted copy of it. `queue_jobs` is the queue itself and exists only for the `pg` backend. It has no foreign key to `videos`, because the queue should not know anything about the app; in the `bullmq` backend, Redis holds the same information instead. The schema is plain SQL files in `src/db/migrations/`, applied in name order by `pnpm db:migrate`.

```mermaid
erDiagram
  videos ||--|{ renditions : "converted into"

  videos {
    uuid id PK
    video_status status "queued|processing|ready|failed"
    text original_filename
    text source_key "path of the upload in SeaweedFS"
    bigint size_bytes
    int duration_ms "from probe"
    int width "from probe"
    int height "from probe"
    text thumbnail_key "path of the thumbnail in SeaweedFS"
    smallint renditions_total "3"
    smallint renditions_done "counts up to 3"
    text error
    timestamptz created_at
    timestamptz updated_at
  }
  renditions {
    uuid id PK
    uuid video_id FK
    text resolution "1080p|720p|480p, UNIQUE with video_id"
    rendition_status status "pending|ready|failed"
    text output_key "path of the converted file in SeaweedFS"
    bigint size_bytes
    timestamptz finished_at
  }
  queue_jobs {
    bigint id PK
    text job_type "probe|thumbnail|transcode|noop|sleep"
    jsonb payload "e.g. videoId + resolution"
    job_status status "queued|running|dead (completed rows are deleted)"
    smallint attempts
    smallint max_attempts
    timestamptz run_at "not before this time"
    text locked_by "worker holding the lease"
    timestamptz locked_until "lease end"
    text idempotency_key UK
    timestamptz enqueued_at
    timestamptz started_at
    text last_error
  }
```

`job_type` is the kind of job, which BullMQ calls the queue name; it is not the backend (that is `QUEUE_BACKEND`). There is no priority: every job has the same weight, and jobs that are due are taken in `id` order (FIFO). `run_at` covers both delayed jobs and retry backoff.

### Indexes

```sql
-- The fetch path: FIFO by id; only queued rows are indexed, so the index stays small as rows churn
CREATE INDEX queue_jobs_fetch ON queue_jobs (job_type, id) WHERE status = 'queued';
-- The reaper path
CREATE INDEX queue_jobs_lease ON queue_jobs (locked_until) WHERE status = 'running';
CREATE UNIQUE INDEX queue_jobs_idem ON queue_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Queue tables churn fast; vacuum them more often than the default (tune and measure)
ALTER TABLE queue_jobs SET (autovacuum_vacuum_scale_factor = 0.01);
```

### Claim (pg)

```sql
WITH next AS (
  SELECT id FROM queue_jobs
  WHERE job_type = $1 AND status = 'queued' AND run_at <= now()
  ORDER BY id
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE queue_jobs j
SET status = 'running', locked_by = $3,
    locked_until = now() + $4 * interval '1 millisecond',
    started_at = now(), attempts = attempts + 1
FROM next WHERE j.id = next.id
RETURNING j.*;
```

- **Heartbeat:** `UPDATE queue_jobs SET locked_until = now() + … WHERE id = $1 AND locked_by = $2`. Zero rows updated means the lease was lost; abort the job.
- **Complete:** `DELETE FROM queue_jobs WHERE id = $1 AND locked_by = $2`. The `locked_by` check stops a worker whose lease expired from completing a job another worker now owns.
- **Fail:** set `status` to `dead` if `attempts >= max_attempts`, else back to `queued` with `run_at = now() + backoff`.
- **Reaper:** the same update for every row `WHERE status = 'running' AND locked_until < now()`.
- **Wake-up:** enqueue runs `pg_notify('jobs', queue)` in the same transaction (delivered on commit). Workers `LISTEN` on a dedicated connection and fall back to polling, so a missed notification only adds delay.

**Future work, `pg-txlock` (not built):** run the same `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` inside `BEGIN`, keep the transaction open while the job runs, then delete the row and commit. No lease columns or reaper are needed, but each running job holds a database connection.

### Fan-in without double counting

Fan-in means waiting until all 3 renditions are done before marking the video `ready`. Because a job can run twice after a crash, a repeat must not be counted. The `renditions` row is the guard: only the first finish changes it to `ready`. The row lock taken by `UPDATE videos` makes finishes that arrive together wait in line, so exactly one of them sets the video to `ready`.

```sql
BEGIN;
UPDATE renditions SET status = 'ready', output_key = $3, finished_at = now()
WHERE video_id = $1 AND resolution = $2 AND status <> 'ready'
RETURNING id;            -- 0 rows: this was a repeat run, stop here

UPDATE videos
SET renditions_done = renditions_done + 1,
    status = CASE WHEN renditions_done + 1 = renditions_total THEN 'ready' ELSE status END,
    updated_at = now()
WHERE id = $1;
COMMIT;
```

## State machines

A job has four states in the pg backend; BullMQ's states map onto them, which is how the dashboards show both backends with the same labels.

```mermaid
stateDiagram-v2
  [*] --> queued : enqueue (run_at = now or delayed)
  queued --> running : claimed, lease set
  running --> completed : handler succeeded (row deleted)
  running --> queued : error, retries left (run_at = now + backoff)
  running --> queued : lease expired, reaper requeues
  running --> queued : graceful shutdown released it
  running --> dead : attempts = max
  dead --> queued : manual retry
  completed --> [*]
```

| pg backend     | BullMQ                            | Notes                                                                                                                       |
| -------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `queued`       | `waiting`, `delayed`              | `delayed` = `run_at` in the future                                                                                          |
| `running`      | `active`                          |                                                                                                                             |
| `completed`    | `completed`                       | Removed on completion in both (BullMQ needs `removeOnComplete: true`, so a finished job's ID can be queued again, as in pg) |
| `dead`         | `failed` (after the last attempt) |                                                                                                                             |
| reaper requeue | stalled-job check                 | Set BullMQ `lockDuration` and `stalledInterval` to match `LEASE_MS` and the reaper interval                                 |

The video moves through its own states, driven by job completions:

```mermaid
stateDiagram-v2
  [*] --> queued : upload saved, probe job queued
  queued --> processing : probe finished, 4 jobs queued
  processing --> ready : last rendition finished (fan-in)
  queued --> failed : probe used up its retries
  processing --> failed : a transcode used up its retries
  ready --> [*]
  failed --> [*]
```

## Sequence diagrams

### 1. Upload and processing pipeline

The upload goes through the API into SeaweedFS in one request. One probe job fans out into one thumbnail job and three transcode jobs, and the client polls for the result. (Uploading straight to SeaweedFS with a presigned URL is a later improvement: it keeps large files off the API, but adds two extra steps.)

```mermaid
sequenceDiagram
  autonumber
  actor C as Client
  participant API
  participant S3 as SeaweedFS
  participant PG as Postgres
  participant Q as Queue (pg or BullMQ)
  participant W as Workers

  C->>API: POST /videos (file upload)
  API->>S3: stream file to sources/:id
  Note over API,Q: pg backend - one transaction. BullMQ - commit, then add with jobId
  API->>PG: INSERT videos (status queued)
  API->>Q: queue probe (id probe:videoId)
  API-->>C: 202 Accepted + videoId

  Q->>W: a worker takes probe
  W->>S3: ffprobe reads the file
  W->>PG: save length and size, status processing, INSERT 3 renditions (pending)
  W->>Q: queue thumbnail + transcode x3

  par 1080p
    Q->>W: a worker takes transcode 1080p
    W->>S3: ffmpeg converts, upload renditions/:id/1080p.mp4
    W->>PG: fan-in update (1 of 3 done)
  and 720p
    Q->>W: a worker takes transcode 720p
    W->>S3: upload renditions/:id/720p.mp4
    W->>PG: fan-in update (2 of 3 done)
  and 480p
    Q->>W: a worker takes transcode 480p
    W->>S3: upload renditions/:id/480p.mp4
    W->>PG: fan-in update (3 of 3 done), status ready
  and thumbnail
    Q->>W: a worker takes thumbnail
    W->>S3: upload thumbnails/:id.jpg
    W->>PG: save thumbnail_key
  end

  loop until status is ready or failed
    C->>API: GET /videos/:id
    API-->>C: status + links to the renditions
  end
```

The order inside `par` is not fixed: whichever transcode finishes last sets the video to `ready`. Each rendition is first encoded to a local temp file, then uploaded. An S3 upload only becomes visible once it is complete, so a repeated job simply overwrites the same file.

### 2. Crash recovery (pg)

The recovery time this test measures is at most the lease length plus the reaper interval. Values below are example config, not measurements.

```mermaid
sequenceDiagram
  participant W1 as Worker 1
  participant PG as queue_jobs
  participant R as Reaper (any worker)
  participant W2 as Worker 2

  W1->>PG: claim job 42 (locked_until = now + LEASE_MS)
  loop every HEARTBEAT_MS (e.g. 10 s)
    W1->>PG: extend locked_until
  end
  Note over W1: kill -9, no cleanup runs
  loop every REAP_MS
    R->>PG: requeue running rows whose lease expired
  end
  PG-->>R: job 42 back to queued
  W2->>PG: claim job 42 (attempt 2)
  W2->>PG: DELETE job 42 (completed)
  Note over W2,PG: test asserts the job finished exactly once and output exists
```

In `bullmq` the stalled-job check plays the reaper's part; a job that stalls more than `maxStalledCount` times is failed.

### 3. Graceful shutdown

```mermaid
sequenceDiagram
  participant D as Docker
  participant W as Worker
  participant Q as Queue
  participant F as ffmpeg child

  D->>W: SIGTERM
  W->>W: /readyz returns 503, stop claiming
  alt in-flight jobs finish within SHUTDOWN_GRACE_MS
    W->>Q: complete jobs
  else grace period runs out
    W->>F: abort via AbortSignal (kill child)
    W->>Q: release jobs to queued (attempt not counted)
  end
  W->>Q: close connections
  W-->>D: exit 0
```

Two Docker details make this work. Docker sends SIGKILL after `stop_grace_period` (10 s by default), so set it above `SHUTDOWN_GRACE_MS`. And Node must actually receive SIGTERM: use the exec form of `CMD` and `init: true` in Compose.

## Deployment (Docker Compose)

One `compose.yaml` with three profiles: `core` (the platform), `obs` (monitoring) and `bench` (load generator). `docker compose --profile core --profile obs up --scale worker=3` starts a full run.

**Configuration.** Images carry no configuration: `.env` is in `.dockerignore`, and every setting reaches a container through Compose `environment:` when it starts. Compose reads the values from the repo-root `.env` (`--env-file .env`), the same file the app reads locally. Containers build their connection string from the same variables, with the service name as the host: `DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}` (not `localhost`, which inside a container is the container itself).

| Service                                     | Profile | Image                                      | Replicas      | Host port | Notes                                                                     |
| ------------------------------------------- | ------- | ------------------------------------------ | ------------- | --------- | ------------------------------------------------------------------------- |
| api                                         | core    | built from `Dockerfile`, command `api`     | 1             | 3000      | Waits for postgres, redis, seaweedfs to be healthy                        |
| migrate                                     | core    | same image as api                          | runs once     | —         | Applies SQL migrations, then exits; api waits for it                      |
| worker                                      | core    | built from `Dockerfile`, command `worker`  | 3 (`--scale`) | none      | CPU limit per replica; `init: true`; metrics on internal port 9100        |
| postgres                                    | core    | `postgres` (pin the major version)         | 1             | 5432      | Named volume; healthcheck `pg_isready`                                    |
| redis                                       | core    | `redis` (pinned)                           | 1             | 6379      | AOF on or off per experiment via command flag                             |
| seaweedfs                                   | core    | `chrislusf/seaweedfs`                      | 1             | 8333 (S3) | Command `server -s3`; the bucket is created on startup through the S3 API |
| prometheus                                  | obs     | `prom/prometheus`                          | 1             | 9090      | Config mounted from `infra/prometheus`                                    |
| grafana                                     | obs     | `grafana/grafana`                          | 1             | 3001      | Datasource and dashboards provisioned from `infra/grafana`                |
| postgres-exporter, redis-exporter, cadvisor | obs     | community images                           | 1 each        | —         | Connections, dead rows, Redis memory, per-container CPU                   |
| loadgen                                     | bench   | built from `Dockerfile`, command `loadgen` | runs once     | —         | `docker compose run loadgen --tier sleep --backend pg …`                  |

**Fair benchmarks on one machine**

- Give each worker the same `cpus` limit, and pin workers and databases to separate cores with `cpuset`, so ffmpeg cannot starve Postgres or Redis.
- Record the host's CPU, RAM, disk and Docker version in every results file.
- Restart Postgres and Redis between runs, or at least empty the queues, so one run's bloat does not leak into the next.

## Observability

Every metric carries a `backend` label, so one Grafana dashboard with a `$backend` variable compares the backends side by side.

| Metric                   | Type      | Labels                  | Emitted by                                   | Answers                                                                          |
| ------------------------ | --------- | ----------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `jobs_enqueued_total`    | counter   | queue, backend          | api, worker, loadgen                         | Arrival rate                                                                     |
| `job_queue_wait_seconds` | histogram | queue, backend          | worker                                       | Time from enqueue to claim (p50/p95/p99)                                         |
| `job_duration_seconds`   | histogram | queue, backend, outcome | worker                                       | Handler run time                                                                 |
| `jobs_finished_total`    | counter   | queue, backend, outcome | worker                                       | Throughput; outcome = completed, retried, dead                                   |
| `jobs_in_flight`         | gauge     | queue, backend          | worker                                       | Concurrency actually reached                                                     |
| `queue_depth`            | gauge     | queue, backend, state   | api (sampled every few seconds)              | Backlog                                                                          |
| `job_recovery_seconds`   | histogram | backend                 | worker                                       | Time from lease expiry or stall to the next claim                                |
| `lease_lost_total`       | counter   | backend                 | worker                                       | Heartbeats that found the job taken                                              |
| `transcode_speed_ratio`  | histogram | resolution              | worker                                       | Video duration ÷ encode time                                                     |
| From exporters           | —         | —                       | postgres-exporter, redis\_exporter, cAdvisor | Connections in use, dead tuples on `queue_jobs`, Redis memory, per-container CPU |

**Histogram buckets per queue.** A no-op job waits well under a millisecond and a transcode runs for minutes, so one bucket set cannot resolve both. Use fine buckets (sub-millisecond up to a few seconds) for the synthetic queues and coarse ones (seconds up to tens of minutes) for `transcode`.

**Timestamps.** `enqueued_at` is set by the producer and the claim time by the worker. On one Docker host every container reads the same kernel clock, so the difference is valid. If you ever spread workers across machines, take both timestamps from the database or Redis server instead.

**Dashboards** (JSON in `infra/grafana/dashboards`): _Queue comparison_ (throughput, wait percentiles, in-flight, depth) ships first. _Infrastructure_ (CPU per container, Postgres connections and dead tuples, Redis memory) follows because the exporters are already running; _Pipeline_ (videos per state, end-to-end time per video, transcode speed) comes with the video pipeline.

## Testing strategy

The core of the suite is one contract suite run against both backends (`describe.each(['pg', 'bullmq'])`). If a backend passes it, the benchmark compares like with like.

| Layer                | Tooling                                                            | What it proves                                                                                                                                                                      | When it runs            |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Unit                 | Vitest                                                             | Handlers with fake storage and media, backoff math, fan-in logic, config parsing                                                                                                    | Every push              |
| Queue contract       | Vitest + Testcontainers (Postgres, Redis)                          | Enqueue and claim; FIFO by `id`; delayed `run_at`; retry then `dead`; idempotency key drops duplicates; no job claimed twice with 50 concurrent consumers                           | Every push              |
| API                  | Fastify `inject`                                                   | Validation, status codes, presigned URL shape                                                                                                                                       | Every push              |
| Pipeline integration | Vitest + Testcontainers (Postgres, Redis, SeaweedFS) + real ffmpeg | Upload a 3-second sample video, it reaches `ready` with 3 renditions and a thumbnail                                                                                                | Every push              |
| Failure              | Docker Compose, on `main` or manual                                | `kill -9` a worker mid-transcode: the job finishes exactly once on another worker. SIGTERM: in-flight job completes or is released. Restart Redis and Postgres mid-run: no job lost | Pushes to main + manual |
| Benchmark smoke      | loadgen with tiny job counts                                       | The harness still runs end to end (not for numbers)                                                                                                                                 | Manual                  |

Generate the sample video in the test setup instead of committing binaries:

```bash
ffmpeg -f lavfi -i testsrc=duration=3:size=1280x720:rate=30 -c:v libx264 -pix_fmt yuv420p sample.mp4
```

Testcontainers is used for integration tests so they run the same locally and in CI. GitHub Actions service containers cannot pass a start command, which SeaweedFS needs (`server -s3`).

Publish benchmark numbers from your own machine, with its hardware listed. GitHub-hosted runners are shared VMs, so their numbers vary from run to run.

## CI/CD (GitHub Actions)

A pull request merges only after lint, types and the test layers pass. There is no production server, so there is no deploy step and images are not published; CI builds the Docker images to prove they build.

```mermaid
flowchart LR
  A[push or PR] --> B[lint + typecheck]
  B --> C[unit + API tests]
  B --> D[contract + pipeline tests<br/>Testcontainers]
  C --> E[docker build<br/>worker, api, loadgen]
  D --> E
  E --> F{branch is main?}
  F -- no --> G[PR checks green]
  F -- yes --> H[failure tests<br/>kill -9, SIGTERM]
  M[manual run] --> L[short benchmark<br/>results saved as artifact]
```

| Workflow    | Trigger                                             | Jobs                                                                    |
| ----------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `ci.yml`    | push, pull\_request                                 | Lint, typecheck, tests, image build; on `main` also the failure tests   |
| `bench.yml` | manual (`workflow_dispatch`, inputs: tier, backend) | Short benchmark run; uploads raw results as a workflow artifact (later) |

Use a pnpm store cache keyed on the lockfile, `docker/build-push-action` with `cache-from: type=gha` for image layers, and a branch protection rule that requires `ci.yml` to pass.

## Repo layout and build order

A single standard Node package: one `package.json`, one `tsconfig.json`, plain folders under `src/`. Modules stay decoupled by convention (for example `src/queue` never imports from `src/worker`), not by separate packages. Entries marked _later_ are created when the build order reaches them.

```text
queue-lab/
├─ src/
│  ├─ queue/          JobQueue types, pg and bullmq adapters
│  ├─ db/             createPool, SQL migrations, queries
│  ├─ lib/            shutdown helper shared by api and worker
│  ├─ config.ts       loadConfig(env), shared by all processes
│  ├─ worker/         createWorker, job handlers, health + metrics server
│  ├─ loadgen/        workload tiers, saves results to bench/results/   (milestone 3)
│  ├─ api/            app.ts (buildApp: routes) + server.ts (entry, graceful shutdown)
│  ├─ storage/        ObjectStorage + S3 client for SeaweedFS           (later)
│  └─ media/          ffprobe / ffmpeg wrappers                         (later)
├─ test/              queue contract suite, integration tests
├─ infra/
│  ├─ compose.yaml
│  ├─ prometheus/     prometheus.yml
│  └─ grafana/        provisioning + dashboards/*.json
├─ bench/
│  ├─ results/        raw results per run (JSON), committed
│  └─ analysis/       scripts that turn results into the README charts
├─ docs/              this document
├─ .github/workflows/ ci.yml, bench.yml
└─ README.md          results first, then architecture, then how to reproduce
```

Each process (worker, api, loadgen) is a separate entry file in the same package, for example `node dist/worker/main.js`. Docker images build from the same `Dockerfile` with a different command.

**Build order.** The first comparison exists by milestone 3, before any video code is written. Milestones 1–4 are the core project and are publishable on their own.

1. `src/queue` with the `pg` adapter, plus the contract suite.
2. The `bullmq` adapter passing the same suite.
3. Worker runtime, `noop` and `sleep` handlers, loadgen tiers 1–2, metrics: first benchmark results.
4. Crash and shutdown tests, the _Queue comparison_ dashboard, README with charts, write-up post.
5. Pipeline (stretch): SeaweedFS, API, probe, thumbnail, transcode, fan-in, the _Pipeline_ and _Infrastructure_ dashboards, the mixed workload.

## Future work

- `pg-txlock`: a third backend that holds a transaction open while the job runs (no reaper, one connection per running job).
- Presigned uploads straight to object storage.
- Publishing images to a registry, if the project ever gets a deployment target.
