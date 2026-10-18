import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

@Injectable()
export class DashboardGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const key = process.env.DASHBOARD_API_KEY;
    if (!key || key.length < 32) throw new ServiceUnavailableException('Dashboard access is not configured');
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw new UnauthorizedException('Dashboard authentication required');
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(hash(header.slice(7)), hash(key))) throw new UnauthorizedException('Invalid dashboard credentials');
    return true;
  }
}
