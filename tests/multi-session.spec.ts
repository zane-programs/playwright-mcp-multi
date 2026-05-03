/**
 * Copyright 2026 Zane St. John
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import child_process from 'child_process';
import path from 'path';

import { test, expect } from './fixtures';

const MULTI_CLI = path.resolve(__dirname, '..', 'multi-cli.js');

const SESSION_TOOL_NAMES = new Set([
  'browser_session_new',
  'browser_session_list',
  'browser_session_close',
]);

function parseJsonText(response: any): any {
  const first = response.content?.[0];
  if (!first || first.type !== 'text')
    throw new Error('Expected text content in response');
  return JSON.parse(first.text);
}

test('list-tools-augmented: every browser_* tool gains a session arg', async ({ startMultiClient }) => {
  const { client } = await startMultiClient();
  const { tools } = await client.listTools();
  for (const tool of tools) {
    if (!tool.name.startsWith('browser_'))
      continue;
    if (SESSION_TOOL_NAMES.has(tool.name))
      continue;
    expect(tool.inputSchema, `${tool.name} should have an object inputSchema`).toBeTruthy();
    const schema: any = tool.inputSchema;
    expect(schema.type, `${tool.name}.inputSchema.type`).toBe('object');
    expect(schema.properties, `${tool.name}.inputSchema.properties`).toBeTruthy();
    expect(schema.properties.session, `${tool.name} missing session property`).toBeTruthy();
    expect(schema.properties.session.type, `${tool.name}.session.type`).toBe('string');
  }
});

test('list-tools-includes-session-tools', async ({ startMultiClient }) => {
  const { client } = await startMultiClient();
  const { tools } = await client.listTools();
  const names = new Set(tools.map(t => t.name));
  for (const expected of SESSION_TOOL_NAMES)
    expect(names.has(expected), `expected ${expected} in tool list`).toBe(true);
});

test('default-session-implicit: no session arg auto-uses default', async ({ startMultiClient, server }) => {
  const { client } = await startMultiClient();
  const navResp = await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });
  expect(navResp.isError, 'navigate should succeed').toBeFalsy();
  const listResp = await client.callTool({ name: 'browser_session_list', arguments: {} });
  const list = parseJsonText(listResp);
  expect(list.sessions.length).toBe(1);
  expect(list.sessions[0].name).toBe('default');
  expect(list.sessions[0].isDefault).toBe(true);
});

test('two-named-sessions-isolated: sessions navigate independently', async ({ startMultiClient, server }) => {
  server.setContent('/one', '<title>OnePage</title><body>page-one-marker</body>', 'text/html');
  server.setContent('/two', '<title>TwoPage</title><body>page-two-marker</body>', 'text/html');

  const { client } = await startMultiClient();

  const newA = await client.callTool({ name: 'browser_session_new', arguments: { name: 'a' } });
  expect(newA.isError, JSON.stringify(newA)).toBeFalsy();
  const newB = await client.callTool({ name: 'browser_session_new', arguments: { name: 'b' } });
  expect(newB.isError, JSON.stringify(newB)).toBeFalsy();

  await client.callTool({ name: 'browser_navigate', arguments: { session: 'a', url: server.PREFIX + 'one' } });
  await client.callTool({ name: 'browser_navigate', arguments: { session: 'b', url: server.PREFIX + 'two' } });

  const snapA = await client.callTool({ name: 'browser_snapshot', arguments: { session: 'a' } });
  const snapB = await client.callTool({ name: 'browser_snapshot', arguments: { session: 'b' } });
  const aText = (snapA.content?.[0] as any)?.text || '';
  const bText = (snapB.content?.[0] as any)?.text || '';
  expect(aText).toContain('page-one-marker');
  expect(aText).not.toContain('page-two-marker');
  expect(bText).toContain('page-two-marker');
  expect(bText).not.toContain('page-one-marker');
});

test('close-then-call-fails-cleanly: closing a session does not break others', async ({ startMultiClient, server }) => {
  const { client } = await startMultiClient();
  await client.callTool({ name: 'browser_session_new', arguments: { name: 'a' } });
  await client.callTool({ name: 'browser_session_new', arguments: { name: 'b' } });

  const closeA = await client.callTool({ name: 'browser_session_close', arguments: { name: 'a' } });
  expect(closeA.isError).toBeFalsy();

  const failedNav = await client.callTool({
    name: 'browser_navigate',
    arguments: { session: 'a', url: server.HELLO_WORLD },
  });
  expect(failedNav.isError).toBe(true);
  const errText = (failedNav.content?.[0] as any)?.text || '';
  expect(errText).toContain('a');
  expect(errText.toLowerCase()).toMatch(/does not exist|closed|failed/);

  const okNav = await client.callTool({
    name: 'browser_navigate',
    arguments: { session: 'b', url: server.HELLO_WORLD },
  });
  expect(okNav.isError, JSON.stringify(okNav)).toBeFalsy();
});

test('cross-process-collision: same profile root + same name in two proxies returns clean error', async ({ startMultiClient }, testInfo) => {
  const sharedRoot = testInfo.outputPath('shared-collision-root');
  const { client: clientA } = await startMultiClient({ profileRoot: sharedRoot });
  const { client: clientB } = await startMultiClient({ profileRoot: sharedRoot });

  const newA = await clientA.callTool({ name: 'browser_session_new', arguments: { name: 'shared' } });
  expect(newA.isError, JSON.stringify(newA)).toBeFalsy();
  await clientA.callTool({
    name: 'browser_navigate',
    arguments: { session: 'shared', url: 'about:blank' },
  });

  const newB = await clientB.callTool({ name: 'browser_session_new', arguments: { name: 'shared' } });
  expect(newB.isError, 'second proxy should fail to claim same session profile').toBe(true);
  const errText = (newB.content?.[0] as any)?.text || '';
  expect(errText.toLowerCase()).toMatch(/locked|in use|singleton/);
});

test('close-default-rejected', async ({ startMultiClient }) => {
  const { client } = await startMultiClient();
  const resp = await client.callTool({ name: 'browser_session_close', arguments: { name: 'default' } });
  expect(resp.isError).toBe(true);
  const text = (resp.content?.[0] as any)?.text || '';
  expect(text.toLowerCase()).toContain('default');
});

test('session-new duplicate name rejected', async ({ startMultiClient }) => {
  const { client } = await startMultiClient();
  const a1 = await client.callTool({ name: 'browser_session_new', arguments: { name: 'dup' } });
  expect(a1.isError, JSON.stringify(a1)).toBeFalsy();
  const a2 = await client.callTool({ name: 'browser_session_new', arguments: { name: 'dup' } });
  expect(a2.isError).toBe(true);
  const text = (a2.content?.[0] as any)?.text || '';
  expect(text.toLowerCase()).toContain('already');
});

test('smoke-help: --help exits 0 and lists multi-session flags', async () => {
  const result = child_process.spawnSync(process.execPath, [MULTI_CLI, '--help'], { encoding: 'utf-8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--profile-root');
  expect(result.stdout).toContain('--default-session');
  expect(result.stdout).toContain('--max-sessions');
});

test('per-session-browser-override: list reports per-session browser', async ({ startMultiClient }) => {
  const { client } = await startMultiClient({ args: ['--browser=chromium'] });
  const newResp = await client.callTool({
    name: 'browser_session_new',
    arguments: { name: 'cx', browser: 'chromium' },
  });
  expect(newResp.isError, JSON.stringify(newResp)).toBeFalsy();
  const listResp = await client.callTool({ name: 'browser_session_list', arguments: {} });
  const list = parseJsonText(listResp);
  const cx = list.sessions.find((s: any) => s.name === 'cx');
  expect(cx).toBeTruthy();
  expect(cx.browser).toBe('chromium');
});

test('profileDir in session-new response is reported', async ({ startMultiClient }, testInfo) => {
  const root = testInfo.outputPath('profile-dir-test');
  const { client } = await startMultiClient({ profileRoot: root });
  const resp = await client.callTool({ name: 'browser_session_new', arguments: { name: 'foo' } });
  expect(resp.isError, JSON.stringify(resp)).toBeFalsy();
  const data = parseJsonText(resp);
  expect(data.name).toBe('foo');
  expect(data.profileDir).toContain('foo');
  expect(path.resolve(data.profileDir).startsWith(path.resolve(root))).toBe(true);
});

test('isolated session has null profileDir', async ({ startMultiClient }) => {
  const { client } = await startMultiClient();
  const resp = await client.callTool({
    name: 'browser_session_new',
    arguments: { name: 'iso', isolated: true },
  });
  expect(resp.isError, JSON.stringify(resp)).toBeFalsy();
  const data = parseJsonText(resp);
  expect(data.isolated).toBe(true);
  expect(data.profileDir).toBeNull();
});
