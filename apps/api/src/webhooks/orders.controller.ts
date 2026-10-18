import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OrderCreatedDto } from './order-created.dto';
import { OrdersService } from './orders.service';
import { RawJsonPipe } from './raw-json.pipe';
import { SignatureGuard } from './signature.guard';

@Controller('webhooks')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('orders')
  @UseGuards(SignatureGuard)
  async receive(
    @Body(new RawJsonPipe()) payload: OrderCreatedDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const created = await this.orders.accept(payload);
    response.status(created ? 201 : 200);
    return { order_id: payload.order_id, result: created ? 'accepted' : 'duplicate' };
  }
}
