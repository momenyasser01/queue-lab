-- The hand-written Postgres queue (pg backend only). Completed jobs are deleted,
-- so a row is always queued, running (leased by a worker) or dead.
CREATE TYPE job_status AS ENUM ('queued', 'running', 'dead');

CREATE TABLE queue_jobs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_type        text        NOT NULL,  -- probe|thumbnail|transcode|noop|sleep
  payload         jsonb       NOT NULL,
  status          job_status  NOT NULL DEFAULT 'queued',
  attempts        smallint    NOT NULL DEFAULT 0,
  max_attempts    smallint    NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  run_at          timestamptz NOT NULL DEFAULT now(),  -- not before this time
  locked_by       text,                                -- worker holding the lease
  locked_until    timestamptz,                         -- lease end
  idempotency_key text,
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  last_error      text
);

-- The fetch path: FIFO by id; only queued rows are indexed, so the index stays small as rows churn
CREATE INDEX queue_jobs_fetch ON queue_jobs (job_type, id) WHERE status = 'queued';
-- The reaper path
CREATE INDEX queue_jobs_lease ON queue_jobs (locked_until) WHERE status = 'running';
CREATE UNIQUE INDEX queue_jobs_idem ON queue_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Queue tables churn fast; vacuum them more often than the default (tune and measure)
ALTER TABLE queue_jobs SET (autovacuum_vacuum_scale_factor = 0.01);
