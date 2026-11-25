import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testMatch: [
    'admin-portal-runtime-smoke.spec.ts',
    'admin-completion.spec.ts',
    'admin-permissions.spec.ts',
  ],
  projects: base.projects?.filter((project) =>
    ['chromium', 'webkit'].includes(project.name!),
  ),
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  retries: 0,
  outputDir: 'test-results/admin',
  reporter: [
    ['line'],
    ['html', { outputFolder: 'reports/admin-ci/playwright', open: 'never' }],
    ['junit', { outputFile: 'reports/admin-ci/browser-results.xml' }],
  ],
  use: {
    ...base.use,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
