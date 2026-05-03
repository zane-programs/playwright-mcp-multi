#!/usr/bin/env node
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

const { Command } = require('commander');

const packageJSON = require('./package.json');
const { ProxyServer } = require('./lib/proxy-server.js');
const { defaultProfileRoot } = require('./lib/profile-paths.js');

const program = new Command();

program
    .name('playwright-mcp-multi')
    .version(packageJSON.version)
    .description(
        'Stdio MCP server that multiplexes multiple Playwright browser sessions over one MCP connection. ' +
        'Each browser session runs as its own @playwright/mcp child process with its own user-data-dir, ' +
        'so multiple Claude Code chats and multiple sessions per chat can run simultaneously.')
    .option('--browser <name>', 'default browser engine for new sessions: chromium, firefox, webkit, chrome, msedge')
    .option('--headless', 'run new sessions headless by default')
    .option('--no-sandbox', 'pass --no-sandbox to every spawned session')
    .option('--isolated', 'default new sessions to ephemeral profiles (no logged-in state persists)')
    .option('--config <path>', 'path to a Playwright MCP JSON config applied to every session')
    .option('--output-dir <path>', 'output directory for every session')
    .option('--viewport-size <size>', 'default viewport size, e.g. "1280x720"')
    .option('--device <name>', 'default device emulation, e.g. "iPhone 15"')
    .option('--executable-path <path>', 'default browser executable path')
    .option('--proxy-server <proxy>', 'default proxy server, e.g. "http://myproxy:3128"')
    .option('--ignore-https-errors', 'ignore HTTPS errors in every session')
    .option('--storage-state <path>', 'default storage state JSON path for new sessions')
    .option('--save-session', 'save Playwright sessions into the output directory')
    .option('--user-agent <ua>', 'default user agent string')
    .option('--init-script <path...>', 'JavaScript init scripts applied to every session (repeatable)')
    .option('--init-page <path...>', 'TypeScript page-init scripts applied to every session (repeatable)')
    .option('--caps <caps>', 'comma-separated tool capabilities forwarded to every session, e.g. "vision,pdf"')
    .option('--profile-root <path>', `root directory for per-session persistent profiles. Defaults to ${defaultProfileRoot()}`)
    .option('--default-session <name>', 'name of the auto-created default session', 'default')
    .option('--max-sessions <n>', 'soft cap on concurrent sessions', v => Number.parseInt(v, 10), 8)
    .action(async opts => {
      const defaults = {
        browser: opts.browser,
        headless: !!opts.headless,
        noSandbox: opts.sandbox === false,
        isolated: !!opts.isolated,
        config: opts.config,
        outputDir: opts.outputDir,
        viewportSize: opts.viewportSize,
        device: opts.device,
        executablePath: opts.executablePath,
        proxyServer: opts.proxyServer,
        ignoreHttpsErrors: !!opts.ignoreHttpsErrors,
        storageState: opts.storageState,
        saveSession: !!opts.saveSession,
        userAgent: opts.userAgent,
        initScript: opts.initScript,
        initPage: opts.initPage,
        caps: typeof opts.caps === 'string' ? opts.caps.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        profileRoot: opts.profileRoot,
        defaultSession: opts.defaultSession || 'default',
        maxSessions: Number.isFinite(opts.maxSessions) ? opts.maxSessions : 8,
        version: packageJSON.version,
      };

      const proxy = new ProxyServer(defaults);
      let shuttingDown = false;
      const stop = async signal => {
        if (shuttingDown) return;
        shuttingDown = true;
        try { await proxy.shutdown(); } catch (_) {}
        process.exit(signal === 'SIGINT' ? 130 : 0);
      };
      process.on('SIGINT', () => stop('SIGINT'));
      process.on('SIGTERM', () => stop('SIGTERM'));
      process.on('uncaughtException', err => {
        process.stderr.write(`[playwright-mcp-multi] uncaught: ${err && err.stack || err}\n`);
        stop('UNCAUGHT');
      });

      try {
        await proxy.run();
      } catch (err) {
        process.stderr.write(`[playwright-mcp-multi] fatal: ${err && err.stack || err}\n`);
        await proxy.shutdown().catch(() => {});
        process.exit(1);
      }
    });

void program.parseAsync(process.argv);
