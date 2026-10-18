import { Column, CreateDateColumn, Entity, Index, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SyncAttempt } from './sync-attempt.entity';

export enum OrderSyncStatus {
  Pending = 'pending',
  Processing = 'processing',
  Synced = 'synced',
  Failed = 'failed',
}

@Entity('orders')
@Index('IDX_orders_next_retry_at', ['nextRetryAt'])
export class Order {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'order_id', type: 'text', unique: true })
  orderId!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'enum', enum: OrderSyncStatus, enumName: 'order_sync_status', default: OrderSyncStatus.Pending })
  status!: OrderSyncStatus;

  @Column({ name: 'hubspot_contact_id', type: 'text', nullable: true })
  hubspotContactId!: string | null;

  @Column({ name: 'hubspot_deal_id', type: 'text', nullable: true })
  hubspotDealId!: string | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ name: 'synced_at', type: 'timestamptz', nullable: true })
  syncedAt!: Date | null;

  // Durable automatic retry schedule. NULL means no automatic retry is pending.
  @Column({ name: 'next_retry_at', type: 'timestamptz', nullable: true })
  nextRetryAt!: Date | null;

  // Automatic attempts since the last webhook/manual/command attempt.
  @Column({ name: 'auto_retry_count', type: 'integer', default: 0 })
  autoRetryCount!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => SyncAttempt, (attempt) => attempt.order)
  syncAttempts!: SyncAttempt[];
}
