/**
 * Copyright 2026 Zane St. John
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

import { defineConfig } from '@playwright/test';

import type { TestOptions } from './tests/fixtures';

export default defineConfig<TestOptions>({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    headless: !!process.env.CI || !!process.env.HEADLESS,
  },
  projects: [
    {
      name: 'chrome',
      use: {
        mcpBrowser: 'chromium',
      },
    },
  ],
});
