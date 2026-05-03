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

const path = require('path');

let cached;

function resolveUpstreamCliPath() {
  if (cached)
    return cached;
  const env = process.env.PWMCP_MULTI_UPSTREAM_CLI;
  if (env) {
    cached = path.resolve(env);
    return cached;
  }
  const pkgJsonPath = require.resolve('@playwright/mcp/package.json');
  const pkgRoot = path.dirname(pkgJsonPath);
  const pkg = require(pkgJsonPath);
  const binEntry = typeof pkg.bin === 'string'
    ? pkg.bin
    : (pkg.bin && pkg.bin['playwright-mcp']) || 'cli.js';
  cached = path.resolve(pkgRoot, binEntry);
  return cached;
}

module.exports = { resolveUpstreamCliPath };
