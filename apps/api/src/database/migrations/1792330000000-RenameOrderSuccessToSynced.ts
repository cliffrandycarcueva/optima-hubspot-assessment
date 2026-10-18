import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameOrderSuccessToSynced1792330000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query("ALTER TYPE public.order_sync_status RENAME VALUE 'succeeded' TO 'synced'");
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query("ALTER TYPE public.order_sync_status RENAME VALUE 'synced' TO 'succeeded'");
  }
}
