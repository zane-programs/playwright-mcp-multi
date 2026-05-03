/**
 * Copyright 2026 Zane St. John
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import path from 'path';

import { test as baseTest, expect as baseExpect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { TestServer } from './test-server';

const MULTI_CLI = path.resolve(__dirname, '..', 'multi-cli.js');

export type TestOptions = {
  mcpHeadless: boolean;
  mcpBrowser: string | undefined;
};

export type StartMultiClient = (options?: {
  clientName?: string;
  args?: string[];
  profileRoot?: string;
  defaultSession?: string;
  env?: Record<string, string>;
}) => Promise<{ client: Client; stderr: () => string; profileRoot: string }>;

type WorkerFixtures = {
  _workerServer: TestServer;
};

type TestFixtures = {
  server: TestServer;
  startMultiClient: StartMultiClient;
};

export const test = baseTest.extend<TestFixtures & TestOptions, WorkerFixtures>({
  mcpHeadless: [({ headless }, use) => use(headless), { option: true }],
  mcpBrowser: ['chromium', { option: true }],

  _workerServer: [async ({}, use, workerInfo) => {
    const port = 9100 + workerInfo.workerIndex * 4;
    const server = await TestServer.create(port);
    await use(server);
    await server.stop();
  }, { scope: 'worker' }],

  server: async ({ _workerServer }, use) => {
    _workerServer.reset();
    await use(_workerServer);
  },

  startMultiClient: async ({ mcpHeadless, mcpBrowser }, use, testInfo) => {
    const clients: { client: Client; transport: StdioClientTransport }[] = [];

    await use(async (options = {}) => {
      const profileRoot = options.profileRoot ?? testInfo.outputPath('multi-profiles');
      const args = ['--profile-root', profileRoot];
      if (mcpHeadless)
        args.push('--headless');
      if (mcpBrowser)
        args.push(`--browser=${mcpBrowser}`);
      if (process.env.CI && process.platform === 'linux')
        args.push('--no-sandbox');
      if (options.defaultSession)
        args.push('--default-session', options.defaultSession);
      if (options.args)
        args.push(...options.args);

      let stderrBuffer = '';
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MULTI_CLI, ...args],
        cwd: testInfo.outputPath(),
        stderr: 'pipe',
        env: {
          ...process.env,
          ...(options.env || {}),
        },
      });
      transport.stderr?.on('data', chunk => {
        stderrBuffer += chunk.toString();
        if (process.env.PWMCP_MULTI_DEBUG)
          process.stderr.write(chunk);
      });

      const client = new Client(
          { name: options.clientName ?? 'multi-test', version: '1.0.0' },
          { capabilities: {} });
      await client.connect(transport);
      await client.ping();
      clients.push({ client, transport });
      return { client, stderr: () => stderrBuffer, profileRoot };
    });

    await Promise.all(clients.map(async ({ client, transport }) => {
      try { await client.close(); } catch (_) {}
      try { await transport.close(); } catch (_) {}
    }));
  },
});

export const expect = baseExpect;
