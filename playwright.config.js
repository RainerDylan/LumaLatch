import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const cacheDir = path.resolve('.cache');
const tempDir = path.join(cacheDir, 'tmp');
fs.mkdirSync(tempDir, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(cacheDir, 'ms-playwright');
process.env.TEMP = tempDir;
process.env.TMP = tempDir;

export default defineConfig({
  testDir: './tests/integration',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 5_000 },
  outputDir: path.join(cacheDir, 'test-results'),
  reporter: [['line']],
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off'
  }
});
