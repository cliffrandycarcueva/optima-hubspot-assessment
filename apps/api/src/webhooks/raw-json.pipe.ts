import { ArgumentMetadata, BadRequestException, Injectable, ValidationPipe } from '@nestjs/common';

@Injectable()
export class RawJsonPipe extends ValidationPipe {
  constructor() {
    super({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
      // Do not reflect untrusted values or property names in responses or logs.
      exceptionFactory: () => new BadRequestException('Invalid order.created payload'),
    });
  }

  async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    let parsed: unknown;
    try {
      if (!Buffer.isBuffer(value)) throw new Error();
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value), (key, item: unknown) => {
        // Reject keys class-transformer would otherwise silently discard.
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error();
        for (const text of [key, ...(typeof item === 'string' ? [item] : [])]) {
          // JSONB rejects NUL and unpaired Unicode surrogates.
          if (text.includes('\u0000') || Buffer.from(text, 'utf8').toString('utf8') !== text) throw new Error();
        }
        return item;
      });
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    } catch {
      throw new BadRequestException('Invalid JSON object');
    }
    return super.transform(parsed, metadata);
  }
}
