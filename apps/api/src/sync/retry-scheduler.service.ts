import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { orderRetryPolicy } from '../hubspot/retry';
import { OrderSyncService, SyncResult } from './order-sync.service';

/**
 * Polls PostgreSQL for due automatic retries. The schedule lives in orders.next_retry_at,
 * so it survives restarts; nothing is held in memory or locked while waiting.
 * Started only by the long-running API process (main.ts), never by CLI commands or tests.
 */
@Injectable()
export class RetrySchedulerService implements OnModuleDestroy {
  policy = orderRetryPolicy();
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopped = false;

  constructor(private readonly database: DatabaseService, private readonly synchronization: OrderSyncService) {}

  start(): boolean {
    if (!this.policy.enabled || this.timer) return false;
    this.timer = setInterval(() => {
      // Never overlap ticks; a slow batch simply delays the next poll.
      if (this.running) return;
      this.running = this.runDueRetries().catch(() => undefined).finally(() => { this.running = undefined; });
    }, this.policy.pollIntervalMs);
    return true;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  /** Failed orders whose retry is due, plus stale pending/processing orders left by a crash. */
  async dueOrderIds(limit = 10): Promise<string[]> {
    const rows: { order_id: string }[] = await this.database.source.query(
      'SELECT order_id FROM public.orders WHERE auto_retry_count < $1 AND (' +
      "(status = 'failed' AND next_retry_at <= now()) OR " +
      "(status IN ('pending', 'processing') AND updated_at <= now() - make_interval(secs => $2::double precision / 1000))" +
      ') ORDER BY COALESCE(next_retry_at, updated_at), id LIMIT $3',
      [this.policy.maxAttempts, this.policy.staleAfterMs, limit]);
    return rows.map(row => row.order_id);
  }

  /** One polling pass. Each order goes through the normal lock and eligibility re-check. */
  async runDueRetries(): Promise<{ orderId: string; result: SyncResult | 'error' }[]> {
    const results: { orderId: string; result: SyncResult | 'error' }[] = [];
    for (const orderId of await this.dueOrderIds()) {
      if (this.stopped) break;
      try {
        results.push({ orderId, result: await this.synchronization.synchronize(orderId, { trigger: 'automatic' }) });
      } catch {
        // e.g. database unavailable; the row stays due and is picked up by a later poll.
        results.push({ orderId, result: 'error' });
      }
    }
    return results;
  }
}
