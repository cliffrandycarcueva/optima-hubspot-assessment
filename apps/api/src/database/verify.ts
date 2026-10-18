import assert from 'node:assert/strict';
import dataSource from './data-source';

async function main() {
  await dataSource.initialize();
  try {
    const [database] = await dataSource.query('SELECT current_database() AS database');
    console.log(database);
    const tables = await dataSource.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('orders', 'sync_attempts', 'migrations') ORDER BY table_name"
    );
    assert.deepEqual(tables.map((row: { table_name: string }) => row.table_name), ['migrations', 'orders', 'sync_attempts']);
    console.table(tables);
    assert.equal(await dataSource.showMigrations(), false, 'Pending migrations exist');
    const changes = await dataSource.driver.createSchemaBuilder().log();
    assert.equal(changes.upQueries.length, 0, 'Database schema differs from entities');
    console.log('Verified tables, applied migrations, and entity/schema alignment.');
  } finally {
    await dataSource.destroy();
  }
}
main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
