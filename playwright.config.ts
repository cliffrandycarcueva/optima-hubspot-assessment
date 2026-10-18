import { defineConfig } from '@playwright/test';
import { config } from 'dotenv';
config({ path: 'apps/dashboard/.env.local' });
export default defineConfig({
  testDir: './tests/ui', workers: 1, timeout: 30000,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000', browserName: 'chromium',
    httpCredentials: { username: process.env.DASHBOARD_USERNAME!, password: process.env.DASHBOARD_PASSWORD! },
    viewport: { width: 1440, height: 1000 }, trace: 'off',
  },
});
