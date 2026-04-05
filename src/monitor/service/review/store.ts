import { randomUUID } from "crypto";
import type { ReviewState } from "./types";

const REVIEW_TTL_MS = 60 * 60 * 1000; // 1 hour — prevents file buffer leaks on abandoned reviews

export class ReviewStore {
  private reviews = new Map<string, ReviewState>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  create(state: ReviewState): string {
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

  update(reviewId: string, updates: Partial<ReviewState>): void {
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
