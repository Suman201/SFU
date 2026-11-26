import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', workers: 1, retries: 0, forbidOnly: Boolean(process.env.CI),
  timeout: 240000, expect: { timeout: 20000 },
  projects: [
    { name: 'chromium', testMatch: ['p2-cms-audit-acceptance.spec.ts', 'p2-classroom-acceptance.spec.ts'], use: { browserName: 'chromium' } },
    { name: 'firefox', testMatch: 'p2-cms-audit-acceptance.spec.ts', use: { browserName: 'firefox' } },
    { name: 'webkit', testMatch: 'p2-cms-audit-acceptance.spec.ts', use: { browserName: 'webkit' } }
  ],
  use: { headless: true, actionTimeout: 20000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: 'test-results/p2',
  reporter: [['line'], ['html', { outputFolder: 'reports/p2/browser', open: 'never' }], ['junit', { outputFile: 'reports/p2/browser-results.xml' }]]
});
