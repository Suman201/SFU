import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['p0-learning-journey.spec.ts', 'invoices-acceptance.spec.ts', 'calendar-acceptance.spec.ts'],
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 360000,
  expect: { timeout: 20000 },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: 'test-results/p0',
  reporter: [['line'], ['html', { outputFolder: 'reports/p0/browser', open: 'never' }], ['junit', { outputFile: 'reports/p0/browser-results.xml' }]],
});
