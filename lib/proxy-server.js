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

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { SessionManager } = require('./session-manager.js');
const {
  augmentSchemas,
  sessionTools,
  extractSession,
  SESSION_TOOLS,
} = require('./tool-router.js');

class ProxyServer {
  constructor(defaults) {
    this.defaults = defaults || {};
    this.sessionManager = new SessionManager(defaults);
    this.defaultSessionName = this.sessionManager.defaultName;
    this.server = new Server(
        { name: 'playwright-mcp-multi', version: this.defaults.version || '0.1.0' },
        { capabilities: { tools: {} } });
    this._wireHandlers();
  }

  _wireHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const augmented = augmentSchemas(this.sessionManager.cachedTools || [], this.defaultSessionName);
      const session = sessionTools(this.defaultSessionName);
      return { tools: [...augmented, ...session] };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async req => {
      const name = req.params?.name;
      const args = req.params?.arguments || {};
      try {
        if (SESSION_TOOLS.has(name))
          return await this._handleSessionTool(name, args);
        const { sessionName, forwardedArgs } = extractSession(args, this.defaultSessionName);
        const entry = await this.sessionManager.getOrCreateDefault(sessionName);
        const result = await entry.client.callTool({
          name,
          arguments: forwardedArgs,
        });
        return result;
      } catch (err) {
        return errorResult(err);
      }
    });
  }

  async _handleSessionTool(name, args) {
    if (name === 'browser_session_new') {
      const entry = await this.sessionManager.create(args);
      return jsonResult({
        name: entry.name,
        browser: entry.browser,
        profileDir: entry.profileDir,
        isolated: entry.isolated,
        status: entry.status,
        isDefault: entry.isDefault,
      });
    }
    if (name === 'browser_session_list') {
      return jsonResult({ sessions: this.sessionManager.list() });
    }
    if (name === 'browser_session_close') {
      if (!args || typeof args.name !== 'string')
        throw new Error('browser_session_close requires a "name".');
      const result = await this.sessionManager.close(args.name);
      return jsonResult(result);
    }
    throw new Error(`Unknown session tool: ${name}`);
  }

  async run() {
    await this.sessionManager.bootstrap();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    return new Promise(() => {});
  }

  async shutdown() {
    try { await this.server.close(); } catch (_) {}
    await this.sessionManager.closeAll();
  }
}

function jsonResult(obj) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(obj, null, 2) },
    ],
  };
}

function errorResult(err) {
  const text = (err && err.message) ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

module.exports = { ProxyServer };
