import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialOrdersAndSyncAttempts1792327340615 implements MigrationInterface {
    name = 'InitialOrdersAndSyncAttempts1792327340615'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."attempt_sync_status" AS ENUM('processing', 'succeeded', 'failed')`);
        await queryRunner.query(`CREATE TABLE "sync_attempts" ("id" BIGSERIAL NOT NULL, "order_id" text NOT NULL, "status" "public"."attempt_sync_status" NOT NULL DEFAULT 'processing', "hubspot_contact_id" text, "hubspot_deal_id" text, "error" text, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_61a12996eff208f851444a39a93" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_sync_attempts_started_at" ON "sync_attempts" ("started_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_sync_attempts_order_id" ON "sync_attempts" ("order_id") `);
        await queryRunner.query(`CREATE TYPE "public"."order_sync_status" AS ENUM('pending', 'processing', 'succeeded', 'failed')`);
        await queryRunner.query(`CREATE TABLE "orders" ("id" BIGSERIAL NOT NULL, "order_id" text NOT NULL, "payload" jsonb NOT NULL, "status" "public"."order_sync_status" NOT NULL DEFAULT 'pending', "hubspot_contact_id" text, "hubspot_deal_id" text, "last_error" text, "synced_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_cad55b3cb25b38be94d2ce831db" UNIQUE ("order_id"), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "sync_attempts" ADD CONSTRAINT "FK_8d52e11817a37fa8df2a72451d2" FOREIGN KEY ("order_id") REFERENCES "orders"("order_id") ON DELETE RESTRICT ON UPDATE RESTRICT`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sync_attempts" DROP CONSTRAINT "FK_8d52e11817a37fa8df2a72451d2"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP TYPE "public"."order_sync_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_sync_attempts_order_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_sync_attempts_started_at"`);
        await queryRunner.query(`DROP TABLE "sync_attempts"`);
        await queryRunner.query(`DROP TYPE "public"."attempt_sync_status"`);
    }

}
