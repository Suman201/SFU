import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', workers: 1, retries: 0, forbidOnly: Boolean(process.env.CI),
  timeout: 240000, expect: { timeout: 20000 },
  projects: [
    { name: 'chromium', testMatch: ['p1-post-class-acceptance.spec.ts', 'p1-multi-node.spec.ts', 'pipe-browser-interoperability.spec.ts'], grep: /historical private|multi-node privacy|owner-node publisher reaches|remote publisher reaches/, use: { browserName: 'chromium' } },
    { name: 'firefox', testMatch: 'p1-post-class-acceptance.spec.ts', use: { browserName: 'firefox' } },
    { name: 'webkit', testMatch: 'p1-post-class-acceptance.spec.ts', use: { browserName: 'webkit' } }
  ],
  use: { headless: true, actionTimeout: 20000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: 'test-results/p1',
  reporter: [['line'], ['html', { outputFolder: 'reports/p1/browser', open: 'never' }], ['junit', { outputFile: 'reports/p1/browser-results.xml' }]]
});
