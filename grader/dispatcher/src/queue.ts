// Semaphore (GRADER_CONCURRENCY) + FIFO queue (GRADER_QUEUE_MAX) + 1 in flight per user_id.

export class BusyError extends Error {}

export class Scheduler {
  running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly users = new Set<number>();
  readonly concurrency: number;
  readonly queueMax: number;

  constructor(concurrency: number, queueMax: number) {
    this.concurrency = Math.max(1, concurrency);
    this.queueMax = Math.max(0, queueMax);
  }

  get queued(): number { return this.waiting.length; }

  /** Runs `fn` when a slot is free. `userId` null = not counted per user (hint skeleton checks). */
  async run<T>(userId: number | null, fn: () => Promise<T>): Promise<T> {
    if (userId !== null && this.users.has(userId)) throw new BusyError('you already have a submission being graded');
    if (this.running >= this.concurrency && this.waiting.length >= this.queueMax) {
      throw new BusyError('the grader queue is full');
    }
    if (userId !== null) this.users.add(userId);
    try {
      if (this.running < this.concurrency) this.running++;
      else await new Promise<void>((resolve) => this.waiting.push(resolve)); // slot handed over
      try {
        return await fn();
      } finally {
        const next = this.waiting.shift();
        if (next) next(); else this.running--;
      }
    } finally {
      if (userId !== null) this.users.delete(userId);
    }
  }
}
