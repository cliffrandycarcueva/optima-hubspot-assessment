import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { Order } from './order.entity';

export enum AttemptSyncStatus {
  Processing = 'processing',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

@Entity('sync_attempts')
@Index('IDX_sync_attempts_order_id', ['orderId'])
@Index('IDX_sync_attempts_started_at', ['startedAt'])
export class SyncAttempt {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  // References the unique external order ID, not the internal orders.id.
  @Column({ name: 'order_id', type: 'text' })
  orderId!: string;

  @ManyToOne(() => Order, (order) => order.syncAttempts, { nullable: false, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
  @JoinColumn({ name: 'order_id', referencedColumnName: 'orderId' })
  order!: Order;

  @Column({ type: 'enum', enum: AttemptSyncStatus, enumName: 'attempt_sync_status', default: AttemptSyncStatus.Processing })
  status!: AttemptSyncStatus;

  @Column({ name: 'hubspot_contact_id', type: 'text', nullable: true })
  hubspotContactId!: string | null;

  @Column({ name: 'hubspot_deal_id', type: 'text', nullable: true })
  hubspotDealId!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  // webhook | manual | automatic | command; NULL for attempts recorded before Milestone 6.
  @Column({ name: 'triggered_by', type: 'text', nullable: true })
  triggeredBy!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', default: () => 'now()' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
