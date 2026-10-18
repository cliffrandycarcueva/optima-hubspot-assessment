import { createApplication } from './application';
import { RetrySchedulerService } from './sync/retry-scheduler.service';

async function main() {
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  const app = await createApplication();
  app.enableShutdownHooks();
  try {
    await app.listen(port, '127.0.0.1');
    console.log('Order webhook listening at http://127.0.0.1:' + port + '/webhooks/orders');
    const scheduler = app.get(RetrySchedulerService);
    console.log(scheduler.start()
      ? 'Automatic retries enabled; polling every ' + scheduler.policy.pollIntervalMs / 1000 + 's'
      : 'Automatic retry polling disabled (SYNC_AUTO_RETRY_ENABLED=false)');
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  // Retry-setting validation messages name only the variable and its allowed range.
  if (error instanceof Error && /^(HUBSPOT_RETRY|SYNC_AUTO_RETRY)_/.test(error.message)) console.error(error.message);
  console.error('API startup failed. Check PORT, WEBHOOK_SECRET, database settings, retry settings, and applied migrations.');
  process.exitCode = 1;
});
