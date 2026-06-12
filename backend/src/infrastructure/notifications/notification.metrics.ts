import { Injectable, Logger } from '@nestjs/common';

/**
 * F4 metrics seam for the notification pipeline (consumer + sender). Emitted as
 * structured log lines today; a real metrics backend can hook these later.
 */
@Injectable()
export class NotificationMetrics {
  private readonly logger = new Logger('NotificationMetrics');

  private emit(metric: string, fields: Record<string, unknown> = {}): void {
    this.logger.log({ metric, ...fields });
  }

  // ---- consumer ----
  enqueued(): void {
    this.emit('notification.consumer.enqueued');
  }
  duplicate(): void {
    this.emit('notification.consumer.duplicate');
  }
  skipped(reason: string): void {
    this.emit('notification.consumer.skipped', { reason });
  }
  consumerRetried(): void {
    this.emit('notification.consumer.retried');
  }
  deadLettered(reason: string): void {
    this.emit('notification.consumer.dead_lettered', { reason });
  }
  consumerPaused(): void {
    this.emit('notification.consumer.paused');
  }
  consumerResumed(): void {
    this.emit('notification.consumer.resumed');
  }

  // ---- sender ----
  claimed(count: number): void {
    this.emit('notification.sender.claimed', { count });
  }
  sent(): void {
    this.emit('notification.sender.sent');
  }
  retried(): void {
    this.emit('notification.sender.retried');
  }
  failedPermanent(): void {
    this.emit('notification.sender.failed_permanent');
  }
  failedExhausted(): void {
    this.emit('notification.sender.failed_exhausted');
  }
  senderPaused(): void {
    this.emit('notification.sender.paused');
  }
  senderResumed(): void {
    this.emit('notification.sender.resumed');
  }

  // ---- health (F5) ----
  health(scope: string, fields: { pending: number; failed: number; oldestPendingAgeMs: number }): void {
    this.emit(`notification.${scope}.health`, fields);
  }
}
