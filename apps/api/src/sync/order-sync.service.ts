import { Injectable } from '@nestjs/common';
import { QueryRunner } from 'typeorm';
import { DatabaseService } from '../database/database.service';
import { Order, OrderSyncStatus } from '../database/entities/order.entity';
import { SyncAttempt, AttemptSyncStatus } from '../database/entities/sync-attempt.entity';
import { HubSpotError, HubSpotService } from '../hubspot/hubspot.service';
import { backoffDelay, orderRetryPolicy, parseRetryAfter } from '../hubspot/retry';
import { OrderCreatedDto } from '../webhooks/order-created.dto';
import { RawJsonPipe } from '../webhooks/raw-json.pipe';

export type SyncResult = {
  status: 'synced' | 'failed' | 'processing' | 'not_found' | 'not_eligible';
  skipped?: boolean;
  nextRetryAt?: Date | null;
};
/** Who started an attempt; recorded on sync_attempts.triggered_by. */
export type SyncTrigger = 'webhook' | 'manual' | 'automatic' | 'command';

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OrderSyncService {
  /** Replaceable in tests. */
  retryPolicy = orderRetryPolicy();
  random: () => number = Math.random;

  constructor(private readonly database: DatabaseService, private readonly hubspot: HubSpotService) {}

  /**
   * manual: only currently failed orders (dashboard Retry).
   * automatic: only orders whose durable schedule is due, or stale pending/processing orders.
   * webhook/command: pending, failed, or interrupted orders.
   * Eligibility is always re-checked here, under the per-order lock.
   */
  async synchronize(orderId: string, options: { trigger?: SyncTrigger } = {}): Promise<SyncResult> {
    const trigger = options.trigger ?? 'command';
    const runner = this.database.source.createQueryRunner();
    await runner.connect();
    let locked = false;
    try {
      // Session lock survives short transaction commits, and releases on connection death.
      const [lock] = await runner.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 481516)) AS locked", [orderId]);
      locked = lock.locked;
      if (!locked) return { status: 'processing', skipped: true };
      const order = await runner.manager.findOneBy(Order, { orderId });
      if (!order) return { status: 'not_found' };
      if (trigger === 'manual' && order.status !== OrderSyncStatus.Failed) return { status: 'not_eligible', skipped: true };
      if (trigger === 'automatic' && !this.dueForAutomaticRetry(order)) return { status: 'not_eligible', skipped: true };
      if (order.status === OrderSyncStatus.Synced) return { status: 'synced', skipped: true };

      let attempt!: SyncAttempt;
      await this.transaction(runner, async () => {
        // With the exclusive session lock, any prior unfinished attempts are from
        // an interrupted worker. Preserve them and record a new attempt.
        await runner.manager.createQueryBuilder().update(SyncAttempt)
          .set({ status: AttemptSyncStatus.Failed, error: 'Interrupted before completion; recovered by later processing',
            finishedAt: new Date() })
          .where('order_id = :orderId AND status = :status', { orderId, status: AttemptSyncStatus.Processing })
          .execute();
        order.status = OrderSyncStatus.Processing;
        order.lastError = null;
        order.nextRetryAt = null;
        // Any non-automatic attempt (webhook, manual, command) starts a fresh automatic budget.
        order.autoRetryCount = trigger === 'automatic' ? order.autoRetryCount + 1 : 0;
        await runner.manager.save(order);
        attempt = await runner.manager.save(SyncAttempt, runner.manager.create(SyncAttempt, {
          orderId, status: AttemptSyncStatus.Processing, triggeredBy: trigger,
          hubspotContactId: order.hubspotContactId, hubspotDealId: order.hubspotDealId,
        }));
      });

      try {
        // Includes previously stored orders, not only requests validated in this process.
        const payload = await new RawJsonPipe().transform(Buffer.from(JSON.stringify(order.payload)), {
          type: 'body', metatype: OrderCreatedDto,
        }) as OrderCreatedDto;
        if (payload.order_id !== orderId) throw new HubSpotError('stored_order_id_mismatch');
        await this.hubspot.checkConfiguration(payload.currency);
        await this.hubspot.syncContact(payload, async id => {
          order.hubspotContactId = id;
          attempt.hubspotContactId = id;
          await this.checkpoint(runner, order, attempt);
        });
        order.hubspotDealId = await this.hubspot.ensureDeal(payload, order.hubspotDealId);
        attempt.hubspotDealId = order.hubspotDealId;
        await this.checkpoint(runner, order, attempt);
        await this.hubspot.associate(order.hubspotDealId, order.hubspotContactId!);
        order.status = OrderSyncStatus.Synced;
        order.syncedAt = new Date();
        order.lastError = null;
        order.nextRetryAt = null;
        attempt.status = AttemptSyncStatus.Succeeded;
        attempt.finishedAt = new Date();
        await this.checkpoint(runner, order, attempt);
        return { status: 'synced' };
      } catch (error) {
        let message = error instanceof HubSpotError ? error.message : 'Synchronization failed (validation or database error)';
        // Only transient HubSpot failures are rescheduled; permanent ones wait for a manual retry.
        order.nextRetryAt = error instanceof HubSpotError && error.transient ? this.nextRetryAt(order, error) : null;
        if (error instanceof HubSpotError && error.transient && !order.nextRetryAt && this.retryPolicy.maxAttempts > 0) {
          message += '; automatic retries exhausted';
        }
        order.status = OrderSyncStatus.Failed;
        order.lastError = message;
        order.syncedAt = null;
        attempt.status = AttemptSyncStatus.Failed;
        attempt.error = message;
        attempt.finishedAt = new Date();
        await this.checkpoint(runner, order, attempt);
        return { status: 'failed', nextRetryAt: order.nextRetryAt };
      }
    } finally {
      try {
        if (locked) await runner.query('SELECT pg_advisory_unlock(hashtextextended($1, 481516))', [orderId]);
      } finally { await runner.release(); }
    }
  }

  private dueForAutomaticRetry(order: Order, now = Date.now()): boolean {
    if (order.autoRetryCount >= this.retryPolicy.maxAttempts) return false;
    if (order.status === OrderSyncStatus.Failed) return !!order.nextRetryAt && order.nextRetryAt.getTime() <= now;
    // Pending/processing rows untouched this long were interrupted (crash/restart) before finishing.
    if (order.status === OrderSyncStatus.Pending || order.status === OrderSyncStatus.Processing) {
      return order.updatedAt.getTime() <= now - this.retryPolicy.staleAfterMs;
    }
    return false;
  }

  /** Order-level backoff, never earlier than HubSpot's Retry-After; null once the budget is spent. */
  private nextRetryAt(order: Order, error: HubSpotError): Date | null {
    if (order.autoRetryCount >= this.retryPolicy.maxAttempts) return null;
    const backoff = backoffDelay(order.autoRetryCount + 1, this.retryPolicy, this.random);
    const retryAfter = Math.min(parseRetryAfter(error.retryAfter) ?? 0, MAX_RETRY_AFTER_MS);
    return new Date(Date.now() + Math.max(backoff, retryAfter));
  }

  private async checkpoint(runner: QueryRunner, order: Order, attempt: SyncAttempt) {
    await this.transaction(runner, async () => {
      await runner.manager.save(order);
      await runner.manager.save(attempt);
    });
  }

  private async transaction(runner: QueryRunner, action: () => Promise<void>) {
    await runner.startTransaction();
    try { await action(); await runner.commitTransaction(); }
    catch (error) { await runner.rollbackTransaction(); throw error; }
  }
}
