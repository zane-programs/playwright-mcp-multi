/**
 * Copyright 2026 Zane St. John
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

'use strict';

const SESSION_TOOLS = new Set([
  'browser_session_new',
  'browser_session_list',
  'browser_session_close',
]);

function sessionArgDescription(defaultName) {
  return [
    'Optional name of the browser session to act on. Multiple browser sessions can run',
    `concurrently in this MCP server; omit to use the default session "${defaultName}",`,
    'which is auto-created on first use. Create additional sessions with browser_session_new.',
  ].join(' ');
}

function augmentSchemas(tools, defaultSessionName) {
  const desc = sessionArgDescription(defaultSessionName);
  return tools.map(tool => {
    if (!tool || typeof tool.name !== 'string')
      return tool;
    if (!tool.name.startsWith('browser_') || SESSION_TOOLS.has(tool.name))
      return tool;
    const inputSchema = tool.inputSchema && typeof tool.inputSchema === 'object'
      ? JSON.parse(JSON.stringify(tool.inputSchema))
      : { type: 'object', properties: {} };
    if (inputSchema.type !== 'object')
      inputSchema.type = 'object';
    if (!inputSchema.properties || typeof inputSchema.properties !== 'object')
      inputSchema.properties = {};
    inputSchema.properties.session = {
      type: 'string',
      description: desc,
    };
    return { ...tool, inputSchema };
  });
}

function sessionTools(defaultSessionName) {
  return [
    {
      name: 'browser_session_new',
      title: 'Create a new browser session',
      description: [
        'Create a new browser session backed by a fresh Playwright/Chromium process.',
        'Use this whenever you want a second (or third, or N-th) browser running in parallel',
        'in the SAME chat. Each session gets its own Chromium window, its own user-data-dir,',
        'and its own page state — they cannot see each other\'s tabs or cookies.',
        `Existing browser_* tools accept an optional "session" argument (defaults to "${defaultSessionName}");`,
        'pass the name you choose here to direct subsequent tool calls at this session.',
        'Sessions persist for the lifetime of this MCP server unless closed via browser_session_close.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            description: 'Unique name for the session. Used to target this session in subsequent tool calls via the "session" argument.',
          },
          browser: {
            type: 'string',
            enum: ['chromium', 'firefox', 'webkit', 'chrome', 'msedge'],
            description: 'Override the browser engine for this session. Defaults to the proxy server\'s --browser flag.',
          },
          headless: {
            type: 'boolean',
            description: 'Override the headless setting for this session.',
          },
          isolated: {
            type: 'boolean',
            description: 'If true, use an ephemeral in-memory profile (no logged-in state persists). If false (default), reuse a persistent profile keyed by the session name.',
          },
          userDataDir: {
            type: 'string',
            description: 'Override the persistent profile directory for this session. By default the path is derived from the session name.',
          },
          viewport: {
            type: 'object',
            properties: {
              width: { type: 'number' },
              height: { type: 'number' },
            },
            description: 'Override the viewport size for this session, e.g. {width: 1280, height: 720}.',
          },
          device: {
            type: 'string',
            description: 'Override the device emulation for this session, e.g. "iPhone 15".',
          },
          executablePath: {
            type: 'string',
            description: 'Path to a custom browser executable.',
          },
          proxyServer: {
            type: 'string',
            description: 'Proxy server URL, e.g. "http://myproxy:3128".',
          },
          storageState: {
            type: 'string',
            description: 'Path to a Playwright storage-state JSON file used to seed cookies/localStorage.',
          },
        },
      },
    },
    {
      name: 'browser_session_list',
      title: 'List active browser sessions',
      description: [
        'List every browser session this MCP server is currently managing, with its status,',
        'browser engine, and profile directory. The default session is flagged with isDefault=true.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'browser_session_close',
      title: 'Close a browser session',
      description: [
        'Close a named browser session. Its Chromium process is terminated and its MCP client',
        `is disconnected. Calls targeting the closed session will fail until you create a new one.`,
        `The default session "${defaultSessionName}" cannot be closed via this tool;`,
        'shut down the MCP server itself to release the default session.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Name of the session to close.' },
        },
      },
    },
  ];
}

function extractSession(args, defaultSessionName) {
  if (!args || typeof args !== 'object')
    return { sessionName: defaultSessionName, forwardedArgs: {} };
  const { session, ...forwardedArgs } = args;
  const name = (typeof session === 'string' && session.trim()) ? session.trim() : defaultSessionName;
  return { sessionName: name, forwardedArgs };
}

module.exports = {
  SESSION_TOOLS,
  augmentSchemas,
  sessionTools,
  extractSession,
};
