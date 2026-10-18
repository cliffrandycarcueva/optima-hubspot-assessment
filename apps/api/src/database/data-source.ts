import 'reflect-metadata';
import { config } from 'dotenv';
import { resolve, join } from 'node:path';
import { DataSource } from 'typeorm';
import { Order } from './entities/order.entity';
import { SyncAttempt } from './entities/sync-attempt.entity';

config({ path: resolve(process.cwd(), '.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('Missing required environment variable: ' + name);
  return value;
}

const port = Number(process.env.DB_PORT ?? '5432');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('DB_PORT must be an integer between 1 and 65535');
}

export default new DataSource({
  type: 'postgres',
  host: required('DB_HOST'),
  port,
  username: required('DB_USERNAME'),
  password: required('DB_PASSWORD'),
  database: required('DB_DATABASE'),
  schema: 'public',
  synchronize: false,
  migrationsRun: false,
  migrationsTransactionMode: 'all',
  migrationsTableName: 'migrations',
  entities: [Order, SyncAttempt],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  logging: false,
  connectTimeoutMS: 10000,
});
