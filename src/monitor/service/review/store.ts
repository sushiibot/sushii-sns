import { randomUUID } from "crypto";
import logger from "../../../logger";
import type { ReviewState } from "./types";

const REVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour — prevents file buffer leaks on abandoned reviews

const log = logger.child({ module: "monitor/service/review/store" });

export class ReviewStore {
  private reviews = new Map<string, ReviewState>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly MAX_REVIEWS = 50;

  create(state: ReviewState): string {
    if (this.reviews.size >= this.MAX_REVIEWS) {
      const oldestKey = this.reviews.keys().next().value;
      if (oldestKey !== undefined) {
        log.warn({ reviewId: oldestKey, currentSize: this.reviews.size }, "ReviewStore at capacity, evicting oldest review");
        this.delete(oldestKey);
      }
    }

    const reviewId = randomUUID();
    this.reviews.set(reviewId, state);
    const timer = setTimeout(() => {
      this.reviews.delete(reviewId);
      this.timers.delete(reviewId);
    }, REVIEW_TTL_MS);
    this.timers.set(reviewId, timer);
    return reviewId;
  }

  get(reviewId: string): ReviewState | undefined {
    return this.reviews.get(reviewId);
  }

  update(reviewId: string, updates: { removedIndices?: Set<number>; customContent?: string | null; messageIds?: string[] }): void {
    const state = this.reviews.get(reviewId);
    if (!state) return;
    this.reviews.set(reviewId, { ...state, ...updates });
  }

  delete(reviewId: string): void {
    this.reviews.delete(reviewId);
    const timer = this.timers.get(reviewId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(reviewId);
    }
  }
}
