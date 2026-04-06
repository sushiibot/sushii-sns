/**
 * Serializes **review "Post"** work.
 */
import logger from "../../logger";

const log = logger.child({ module: "monitor/queue" });

interface QueueItem {
  id: string;
  execute: () => Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

const POST_JOB_TIMEOUT_MS = 90_000;

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class PostQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;

  enqueue(execute: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: crypto.randomUUID(), execute, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          log.debug({ queueItemId: item.id }, "Starting post queue job");
          await withTimeout(item.execute(), POST_JOB_TIMEOUT_MS, "post job");
          log.debug({ queueItemId: item.id }, "Finished post queue job");
          item.resolve();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.error({ err: error.message, queueItemId: item.id }, "Post queue job failed");
          item.reject(error);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
