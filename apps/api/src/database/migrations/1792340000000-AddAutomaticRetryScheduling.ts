import { MigrationInterface, QueryRunner } from 'typeorm';

// Additive only: existing rows keep their data. Historical attempts get triggered_by NULL.
export class AddAutomaticRetryScheduling1792340000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "orders" ADD "next_retry_at" TIMESTAMP WITH TIME ZONE');
    await runner.query('ALTER TABLE "orders" ADD "auto_retry_count" integer NOT NULL DEFAULT 0');
    await runner.query('CREATE INDEX "IDX_orders_next_retry_at" ON "orders" ("next_retry_at") ');
    await runner.query('ALTER TABLE "sync_attempts" ADD "triggered_by" text');
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "sync_attempts" DROP COLUMN "triggered_by"');
    await runner.query('DROP INDEX "public"."IDX_orders_next_retry_at"');
    await runner.query('ALTER TABLE "orders" DROP COLUMN "auto_retry_count"');
    await runner.query('ALTER TABLE "orders" DROP COLUMN "next_retry_at"');
  }
}
