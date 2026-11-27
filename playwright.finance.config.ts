import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', testMatch: 'booking-earnings-acceptance.spec.ts', workers: 1, retries: 0, forbidOnly: Boolean(process.env.CI),
  timeout: 240000, expect: { timeout: 20000 },
  projects: ['chromium', 'firefox', 'webkit'].map(name => ({ name, use: { browserName: name as 'chromium' | 'firefox' | 'webkit' } })),
  use: { headless: true, actionTimeout: 20000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: 'test-results/finance',
  reporter: [['line'], ['html', { outputFolder: 'reports/finance/browser', open: 'never' }], ['junit', { outputFile: 'reports/finance/browser-results.xml' }]],
});
