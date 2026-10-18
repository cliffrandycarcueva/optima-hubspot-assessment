import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { raw } from 'express';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './http-error.filter';

export async function createApplication() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: false,
    abortOnError: false,
  });
  configureApplication(app);
  return app;
}

export function configureApplication(app: NestExpressApplication): void {
  // Keep exact bytes until the guard authenticates them. No JSON parser or
  // decompression runs before HMAC verification; compressed bodies are unsupported.
  app.use(raw({ type: () => true, limit: '100kb', inflate: false }));
  app.useGlobalFilters(new HttpErrorFilter());
}
