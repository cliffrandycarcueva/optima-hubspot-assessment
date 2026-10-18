const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const dataSource = require('../dist/database/data-source').default;
const { Order } = require('../dist/database/entities/order.entity');
const { SyncAttempt } = require('../dist/database/entities/sync-attempt.entity');

test('PostgreSQL persistence, idempotency, and attempt history', async () => {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const externalId = 'migration-test-' + randomUUID();
    const orders = runner.manager.getRepository(Order);
    const attempts = runner.manager.getRepository(SyncAttempt);
    const payload = { order_id: externalId, customer: { email: 'test@example.invalid' }, items: [{ qty: 2 }] };
    const order = await orders.save(orders.create({ orderId: externalId, payload }));
    const saved = await orders.findOneByOrFail({ id: order.id });
    assert.deepEqual(saved.payload, payload);
    assert.equal(saved.status, 'pending');
    assert.ok(saved.createdAt instanceof Date);
    assert.ok(saved.updatedAt instanceof Date);

    async function rejectsWithCode(operation, code) {
      await runner.query('SAVEPOINT expected_error');
      try { await assert.rejects(operation, (error) => error.driverError?.code === code); }
      finally { await runner.query('ROLLBACK TO SAVEPOINT expected_error'); }
    }

    await rejectsWithCode(() => orders.insert({ orderId: externalId, payload }), '23505');
    await rejectsWithCode(() => attempts.insert({ orderId: 'missing-' + externalId }), '23503');

    await attempts.save(attempts.create({
      orderId: externalId, status: 'failed', error: 'Simulated timeout',
      hubspotContactId: '12345678901234567890', finishedAt: new Date(),
    }));
    await attempts.save(attempts.create({
      orderId: externalId, status: 'succeeded', hubspotContactId: '12345678901234567890',
      hubspotDealId: '98765432109876543210', finishedAt: new Date(),
    }));
    const history = await attempts.find({ where: { orderId: externalId }, order: { id: 'ASC' } });
    assert.equal(history.length, 2);
    assert.equal(history[0].error, 'Simulated timeout');
    assert.equal(history[1].hubspotDealId, '98765432109876543210');
    assert.ok(history.every((row) => row.startedAt instanceof Date && row.finishedAt instanceof Date));
    await rejectsWithCode(() => orders.delete({ id: order.id }), '23503');
    await rejectsWithCode(() => runner.query(
      'INSERT INTO public.sync_attempts (order_id, status) VALUES ($1, $2)', [externalId, 'invalid']
    ), '22P02');
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
    await dataSource.destroy();
  }
});
