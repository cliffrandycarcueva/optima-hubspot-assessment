import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import dataSource from './data-source';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly source = dataSource;

  async onModuleInit(): Promise<void> {
    await this.source.initialize();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.source.isInitialized) await this.source.destroy();
  }
}
