import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardGuard } from './dashboard/dashboard.guard';
import { HubSpotService } from './hubspot/hubspot.service';
import { OrderSyncService } from './sync/order-sync.service';
import { RetrySchedulerService } from './sync/retry-scheduler.service';
import { DatabaseService } from './database/database.service';
import { OrdersController } from './webhooks/orders.controller';
import { OrdersService } from './webhooks/orders.service';
import { SignatureGuard, WEBHOOK_SECRET } from './webhooks/signature.guard';

@Module({
  controllers: [OrdersController, DashboardController],
  providers: [
    DashboardGuard,
    DatabaseService,
    HubSpotService,
    OrderSyncService,
    RetrySchedulerService,
    OrdersService,
    SignatureGuard,
    {
      provide: WEBHOOK_SECRET,
      useFactory: () => {
        const secret = process.env.WEBHOOK_SECRET;
        if (!secret || !secret.trim()) throw new Error('WEBHOOK_SECRET is required');
        return secret;
      },
    },
  ],
})
export class AppModule {}
