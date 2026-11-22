// Functional queue contract: plain objects of functions, no classes.
// Adapters are factories, e.g. createPostgresQueue(deps): JobQueue.

export type JobId = string

export type EnqueueOptions = {
  /** Fixed ID such as `probe:{videoId}`; a duplicate enqueue is dropped. */
  idempotencyKey?: string
  /** Not before this time. Jobs are otherwise taken in enqueue order (FIFO). */
  runAt?: Date
  maxAttempts?: number
}

export type QueueCounts = {
  queued: number
  running: number
  dead: number
}

export type Consumer = {
  start: () => void
  stop: (graceMs: number) => Promise<void>
}

export type JobContext = {
  jobId: JobId
  attempt: number
  enqueuedAt: Date
  signal: AbortSignal
  heartbeat: () => Promise<void>
  enqueue: (
    queue: string,
    payload: unknown,
    opts?: EnqueueOptions,
  ) => Promise<JobId>
}

export type JobHandler<P = unknown> = {
  queue: string
  handle: (ctx: JobContext, payload: P) => Promise<void>
}

export type ConsumeOptions = {
  concurrency?: number
}

export type JobQueue = {
  /** `tx` lets the Postgres adapter enqueue in the caller's transaction. */
  enqueue: (
    queue: string,
    payload: unknown,
    opts?: EnqueueOptions,
    tx?: unknown,
  ) => Promise<JobId>
  consume: (
    queue: string,
    handler: JobHandler['handle'],
    opts?: ConsumeOptions,
  ) => Consumer
  counts: (queue: string) => Promise<QueueCounts>
  close: () => Promise<void>
}
