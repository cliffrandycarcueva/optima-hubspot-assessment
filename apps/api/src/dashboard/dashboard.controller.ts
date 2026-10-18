import { BadRequestException, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { OrderSyncService } from '../sync/order-sync.service';
import { DashboardGuard } from './dashboard.guard';

function safeError(value: string | null): string | null {
  if (!value) return null;
  for (const name of ['HUBSPOT_ACCESS_TOKEN', 'WEBHOOK_SECRET', 'DB_PASSWORD', 'DASHBOARD_API_KEY']) {
    const secret = process.env[name];
    if (secret && secret.length >= 4) value = value.split(secret).join('[redacted]');
  }
  return value.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
}

@Controller()
@UseGuards(DashboardGuard)
export class DashboardController {
  constructor(private readonly database: DatabaseService, private readonly synchronization: OrderSyncService) {}

  @Get('health')
  async health() {
    try { await this.database.source.query('SELECT 1'); }
    catch { throw new ServiceUnavailableException('Database is unavailable'); }
    return { status: 'ok', database: 'connected', checkedAt: new Date().toISOString() };
  }

  @Get('sync-attempts')
  async attempts(@Query('limit') rawLimit?: string) {
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit))) {
      throw new BadRequestException('limit must be a positive integer');
    }
    const limit = Math.min(Number(rawLimit ?? 50), 50);
    const attempts = await this.database.source.query(
      'SELECT a.id, a.order_id AS "orderId", a.status AS "attemptStatus", o.status AS "orderStatus", ' +
      // Show only IDs this attempt actually recorded, not the order's later IDs.
      'a.hubspot_contact_id AS "contactId", a.hubspot_deal_id AS "dealId", ' +
      'a.error, a.started_at AS "startedAt", a.finished_at AS "finishedAt", a.triggered_by AS "trigger", ' +
      'o.next_retry_at AS "nextRetryAt", o.auto_retry_count AS "autoRetryCount", ' +
      `(o.status = 'failed') AS "retryEligible" ` +
      'FROM public.sync_attempts a JOIN public.orders o ON o.order_id=a.order_id ' +
      'ORDER BY a.started_at DESC, a.id DESC LIMIT $1', [limit]);
    const [pending] = await this.database.source.query(
      "SELECT count(*)::int AS count FROM public.orders WHERE status IN ('pending','processing')");
    const portal = process.env.HUBSPOT_PORTAL_ID;
    return {
      attempts: attempts.map((row: { error: string | null }) => ({ ...row, error: safeError(row.error) })),
      summary: {
        total: attempts.length,
        succeeded: attempts.filter((row: { attemptStatus: string }) => row.attemptStatus === 'succeeded').length,
        failed: attempts.filter((row: { attemptStatus: string }) => row.attemptStatus === 'failed').length,
        inFlightOrders: pending.count,
      },
      scope: 'latest_attempts', limit,
      portalId: portal && /^\d+$/.test(portal) ? portal : null,
    };
  }

  @Post('orders/:orderId/retry')
  @HttpCode(200)
  async retry(@Param('orderId') orderId: string) {
    if (!orderId || orderId.length > 200) throw new BadRequestException('Invalid order ID');
    const result = await this.synchronization.synchronize(orderId, { trigger: 'manual' });
    if (result.status === 'not_found') throw new NotFoundException('Order not found');
    if (result.status === 'processing') throw new ConflictException('This order is already being processed');
    if (result.status === 'not_eligible' || result.skipped) throw new ConflictException('Only currently failed orders can be retried');
    if (result.status === 'failed') throw new ServiceUnavailableException('Synchronization failed. The attempt has been recorded; refresh to view details.');
    return { orderId, status: 'synced', message: 'Order synchronized successfully' };
  }
}
