import { randomUUID } from 'crypto';
import config from '../config/index.js';

export class QueueFullError extends Error {
  constructor(message = 'Scrape queue is full') {
    super(message);
    this.name = 'QueueFullError';
    this.code = 'QUEUE_FULL';
    this.status = 429;
  }
}

class ScrapeQueue {
  constructor(maxSize = 10) {
    this.maxSize = maxSize;
    this.queue = [];
    this.isProcessing = false;
    this.currentJob = null;
  }

  /**
   * Sets the maximum queue capacity.
   * @param {number} size
   */
  setMaxSize(size) {
    this.maxSize = size;
  }

  /**
   * Gets current queue telemetry.
   */
  getStatus() {
    return {
      is_processing: this.isProcessing,
      current_job: this.currentJob ? { id: this.currentJob.id, type: this.currentJob.type, started_at: this.currentJob.startedAt } : null,
      pending_count: this.queue.length,
      max_size: this.maxSize
    };
  }

  /**
   * Enqueues a scrape task to be executed sequentially.
   * Bounded: Throws QueueFullError if queue limit is reached.
   * 
   * @param {Object} item
   * @param {'cycle'|'product'} item.type
   * @param {Function} item.fn - Async function returning execution result
   * @param {Object} [item.metadata]
   * @returns {{ id: string, position: number, promise: Promise<any> }}
   */
  enqueue(item) {
    const { type = 'cycle', fn, metadata = {} } = item;

    if (this.queue.length >= this.maxSize) {
      const err = new QueueFullError(
        `Scrape queue limit reached (${this.queue.length}/${this.maxSize}). Trigger skipped to protect memory and stability.`
      );
      console.warn(`[ScrapeQueue] ⚠️ ${err.message} (Attempted job type: ${type})`);
      throw err;
    }

    const id = randomUUID();
    let resolveJob;
    let rejectJob;

    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });

    const job = {
      id,
      type,
      fn,
      metadata,
      enqueuedAt: Date.now(),
      resolve: resolveJob,
      reject: rejectJob
    };

    this.queue.push(job);
    console.log(`[ScrapeQueue] Job ${id} (${type}) enqueued. Position: ${this.queue.length}/${this.maxSize}`);

    // Trigger queue processor
    this._processNext();

    return {
      id,
      position: this.queue.length,
      promise
    };
  }

  /**
   * Internal queue runner: processes jobs one at a time.
   */
  async _processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const job = this.queue.shift();
    this.currentJob = {
      id: job.id,
      type: job.type,
      startedAt: new Date().toISOString()
    };

    console.log(`[ScrapeQueue] Starting execution of job ${job.id} (${job.type}). Pending jobs remaining: ${this.queue.length}`);

    try {
      const result = await job.fn(job.id);
      job.resolve(result);
    } catch (err) {
      console.error(`[ScrapeQueue] Job ${job.id} (${job.type}) failed:`, err.message);
      job.reject(err);
    } finally {
      this.currentJob = null;
      this.isProcessing = false;
      // Continue next job in queue
      setImmediate(() => this._processNext());
    }
  }

  /**
   * Resets queue state (used for testing).
   */
  clear() {
    this.queue = [];
    this.currentJob = null;
    this.isProcessing = false;
  }
}

export const scrapeQueue = new ScrapeQueue(config.scrapeQueueLimit || 10);
export default scrapeQueue;
