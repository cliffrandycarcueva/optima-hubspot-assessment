import { BadRequestException, CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const WEBHOOK_SECRET = Symbol('WEBHOOK_SECRET');

@Injectable()
export class SignatureGuard implements CanActivate {
  constructor(@Inject(WEBHOOK_SECRET) private readonly secret: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // Express skips parsing an absent body; it still has a well-defined empty HMAC.
    if (request.body === undefined) request.body = Buffer.alloc(0);
    const signature = request.headers['x-webhook-signature'];
    // Exactly one header, with a fixed-size hexadecimal digest.
    const count = request.rawHeaders.filter((_, index) =>
      index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'x-webhook-signature'
    ).length;
    if (count !== 1 || typeof signature !== 'string' ||
        !/^sha256=[0-9a-f]{64}$/.test(signature) || !Buffer.isBuffer(request.body)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    const expected = createHmac('sha256', this.secret).update(request.body).digest();
    const received = Buffer.from(signature.slice(7), 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (!request.is('application/json')) {
      throw new BadRequestException('Content-Type must be application/json');
    }
    return true;
  }
}
