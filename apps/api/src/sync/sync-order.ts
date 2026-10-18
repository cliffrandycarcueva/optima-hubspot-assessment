import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { OrderSyncService } from './order-sync.service';

async function main() {
  const orderId = process.argv[2];
  if (!orderId || process.argv.length !== 3) {
    console.error('Usage: npm run sync:order -- <order_id>'); process.exitCode = 1; return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false });
  try {
    const result = await app.get(OrderSyncService).synchronize(orderId);
    console.log(JSON.stringify(result));
    if (result.status !== 'synced') process.exitCode = 1;
  } finally { await app.close(); }
}
main().catch(() => { console.error('Synchronization could not complete; inspect orders.last_error and configuration.'); process.exitCode = 1; });
