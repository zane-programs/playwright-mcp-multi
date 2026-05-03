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

const fs = require('fs');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const {
  defaultProfileRoot,
  profileDirFor,
  isProfileLockedByOtherProcess,
} = require('./profile-paths.js');
const { resolveUpstreamCliPath } = require('./upstream-cli.js');

const LOCK_RE = /already in use|SingletonLock|ProcessSingleton|user data directory.*in use|profile.*in use/i;
const STDERR_BUFFER_LIMIT = 4096;

class SessionManager {
  constructor(defaults) {
    this.defaults = defaults || {};
    this.defaultName = this.defaults.defaultSession || 'default';
    this.profileRoot = this.defaults.profileRoot || defaultProfileRoot();
    this.maxSessions = Math.max(1, this.defaults.maxSessions || 8);
    this.sessions = new Map();
    this.cachedTools = null;
    this._shuttingDown = false;
    this._cliPath = resolveUpstreamCliPath();
  }

  async bootstrap() {
    fs.mkdirSync(this.profileRoot, { recursive: true });
    const entry = await this._spawnSession({ name: this.defaultName, isDefault: true });
    const result = await entry.client.listTools();
    this.cachedTools = result.tools || [];
    return this.cachedTools;
  }

  list() {
    return Array.from(this.sessions.values()).map(e => ({
      name: e.name,
      browser: e.browser,
      profileDir: e.profileDir || null,
      isolated: e.isolated,
      status: e.status,
      failureReason: e.failureReason,
      isDefault: e.isDefault,
      pid: e.transport && e.transport.pid ? e.transport.pid : null,
    }));
  }

  async getOrCreateDefault(name) {
    const target = name || this.defaultName;
    if (this.sessions.has(target)) {
      const entry = this.sessions.get(target);
      if (entry.status === 'failed')
        throw new Error(`Session "${target}" has failed: ${entry.failureReason || 'unknown reason'}. Close it and create a new one.`);
      if (entry.status === 'closed')
        throw new Error(`Session "${target}" has been closed. Create a new one with browser_session_new.`);
      return entry;
    }
    if (target === this.defaultName)
      return this._spawnSession({ name: this.defaultName, isDefault: true });
    throw new Error(`Session "${target}" does not exist. Call browser_session_new to create it.`);
  }

  async create(opts) {
    if (!opts || typeof opts.name !== 'string' || !opts.name.trim())
      throw new Error('browser_session_new requires a non-empty "name".');
    const name = opts.name.trim();
    if (this.sessions.has(name))
      throw new Error(`Session "${name}" already exists.`);
    if (this.sessions.size >= this.maxSessions)
      throw new Error(`Cannot create session "${name}": max-sessions limit (${this.maxSessions}) reached. Close an existing session first.`);
    return this._spawnSession({
      name,
      isDefault: false,
      browser: opts.browser,
      headless: opts.headless,
      isolated: opts.isolated,
      userDataDir: opts.userDataDir,
      viewport: opts.viewport,
      device: opts.device,
      executablePath: opts.executablePath,
      proxyServer: opts.proxyServer,
      storageState: opts.storageState,
    });
  }

  async close(name) {
    if (!this.sessions.has(name))
      throw new Error(`Session "${name}" does not exist.`);
    if (name === this.defaultName)
      throw new Error('Cannot close the default session; shut down the MCP server instead.');
    const entry = this.sessions.get(name);
    await this._teardown(entry);
    this.sessions.delete(name);
    return { closed: true, name };
  }

  async closeAll() {
    this._shuttingDown = true;
    const entries = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(entries.map(e => this._teardown(e)));
  }

  async _spawnSession(opts) {
    const isolated = opts.isolated ?? this.defaults.isolated ?? false;
    const browser = opts.browser ?? this.defaults.browser;
    const profileDir = isolated
      ? null
      : (opts.userDataDir || profileDirFor(this.profileRoot, opts.name));

    if (profileDir && isProfileLockedByOtherProcess(profileDir)) {
      const err = new Error(
          `Profile "${profileDir}" is locked by another playwright-mcp instance ` +
          `(SingletonLock present and held by a live PID). Use a different session name, ` +
          `pass isolated:true, or close the other process.`);
      err.code = 'PROFILE_LOCKED';
      throw err;
    }

    const args = this._buildArgs(opts, { profileDir, browser, isolated });

    const entry = {
      name: opts.name,
      isDefault: !!opts.isDefault,
      browser: browser || 'chromium',
      isolated,
      profileDir,
      status: 'starting',
      failureReason: undefined,
      args,
      stderrBuffer: '',
      lockDetected: false,
      transport: null,
      client: null,
      _userClosing: false,
    };
    this.sessions.set(opts.name, entry);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this._cliPath, ...args],
      stderr: 'pipe',
      env: { ...process.env },
    });
    entry.transport = transport;

    if (transport.stderr) {
      transport.stderr.on('data', chunk => {
        const text = chunk.toString();
        entry.stderrBuffer = (entry.stderrBuffer + text).slice(-STDERR_BUFFER_LIMIT);
        if (LOCK_RE.test(text))
          entry.lockDetected = true;
        if (process.env.PWMCP_MULTI_DEBUG)
          process.stderr.write(`[session:${entry.name}] ${text}`);
      });
    }

    transport.onclose = () => {
      if (entry._userClosing || this._shuttingDown)
        return;
      if (entry.status === 'starting' || entry.status === 'ready') {
        entry.status = 'failed';
        entry.failureReason = entry.lockDetected
          ? 'profile-locked-by-another-process'
          : (entry.stderrBuffer.trim() || 'child process exited unexpectedly');
      }
    };
    transport.onerror = err => {
      if (entry.status === 'starting' || entry.status === 'ready') {
        entry.status = 'failed';
        entry.failureReason = (err && err.message) || String(err);
      }
    };

    const client = new Client(
        { name: 'playwright-mcp-multi-proxy', version: '0.1.0' },
        { capabilities: {} });
    entry.client = client;

    try {
      await client.connect(transport);
      await client.ping();
    } catch (err) {
      this.sessions.delete(opts.name);
      try { await transport.close(); } catch (_) {}
      const lockSeen = entry.lockDetected || LOCK_RE.test(entry.stderrBuffer);
      if (lockSeen) {
        const e = new Error(
            `Profile "${profileDir}" is locked by another playwright-mcp instance. ` +
            `Use a different session name, pass isolated:true, or close the other process.`);
        e.code = 'PROFILE_LOCKED';
        throw e;
      }
      const e = new Error(`Failed to start session "${opts.name}": ${err.message}\n${entry.stderrBuffer}`.trim());
      e.code = 'SPAWN_FAILED';
      throw e;
    }

    entry.status = 'ready';
    return entry;
  }

  _buildArgs(opts, resolved) {
    const args = [];
    const d = this.defaults;
    if (resolved.browser) {
      args.push('--browser', resolved.browser);
    }
    if (resolved.isolated) {
      args.push('--isolated');
    } else if (resolved.profileDir) {
      args.push('--user-data-dir', resolved.profileDir);
    }
    if (opts.headless !== undefined ? opts.headless : d.headless) {
      args.push('--headless');
    }
    if (d.noSandbox) args.push('--no-sandbox');
    if (opts.executablePath || d.executablePath)
      args.push('--executable-path', opts.executablePath || d.executablePath);
    if (opts.viewport && opts.viewport.width && opts.viewport.height)
      args.push('--viewport-size', `${opts.viewport.width}x${opts.viewport.height}`);
    else if (d.viewportSize)
      args.push('--viewport-size', d.viewportSize);
    if (opts.device || d.device)
      args.push('--device', opts.device || d.device);
    if (opts.proxyServer || d.proxyServer)
      args.push('--proxy-server', opts.proxyServer || d.proxyServer);
    if (opts.storageState || d.storageState)
      args.push('--storage-state', opts.storageState || d.storageState);
    if (d.config) args.push('--config', d.config);
    if (d.outputDir) args.push('--output-dir', d.outputDir);
    if (d.ignoreHttpsErrors) args.push('--ignore-https-errors');
    if (d.saveSession) args.push('--save-session');
    if (d.userAgent) args.push('--user-agent', d.userAgent);
    for (const p of d.initScript || []) args.push('--init-script', p);
    for (const p of d.initPage || []) args.push('--init-page', p);
    if (Array.isArray(d.caps) && d.caps.length)
      args.push('--caps', d.caps.join(','));
    if (Array.isArray(d.passthrough))
      args.push(...d.passthrough);
    return args;
  }

  async _teardown(entry) {
    entry._userClosing = true;
    entry.status = 'closed';
    try { await entry.client?.close(); } catch (_) {}
    try { await entry.transport?.close(); } catch (_) {}
  }
}

module.exports = { SessionManager };
