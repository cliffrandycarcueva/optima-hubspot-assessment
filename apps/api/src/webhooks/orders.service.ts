import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { Order } from '../database/entities/order.entity';
import { OrderCreatedDto } from './order-created.dto';
import { OrderSyncService } from '../sync/order-sync.service';

@Injectable()
export class OrdersService {
  constructor(private readonly database: DatabaseService, private readonly synchronization: OrderSyncService) {}

  async accept(payload: OrderCreatedDto): Promise<boolean> {
    try {
      const result = await this.database.source.getRepository(Order)
        .createQueryBuilder()
        .insert()
        .values({
          orderId: payload.order_id,
          payload: () => ':payload',
        })
        .setParameter('payload', JSON.stringify(payload))
        // Target only the existing order_id uniqueness constraint. There is no
        // check-then-insert race, and duplicates do not overwrite the first payload.
        .onConflict('("order_id") DO NOTHING')
        .returning('order_id')
        .execute();
      const created = result.raw.length === 1;
      if (created) await this.synchronization.synchronize(payload.order_id, { trigger: 'webhook' });
      return created;
    } catch {
      // Do not expose SQL parameters (which include customer data) in logs/errors.
      throw new ServiceUnavailableException('Order could not be stored');
    }
  }
}
