import type { OutboxRelay } from '../../platform/outbox-relay';
import type { ReviewService } from './review.service';

/** JOB-REV-001: rating aggregates follow review changes (FR-REV-006, within a minute via the relay). */
export function registerReviewConsumers(relay: OutboxRelay, reviews: ReviewService): void {
  relay.on('review.changed', (e) =>
    reviews.recompute(
      e.payload as { branchId?: string; restaurantId?: string; partnerId?: string },
    ),
  );
}
