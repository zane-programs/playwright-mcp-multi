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

const os = require('os');
const path = require('path');
const fs = require('fs');

function defaultProfileRoot() {
  const env = process.env.PWMCP_MULTI_PROFILE_ROOT;
  if (env)
    return env;
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright', 'mcp-multi');
    case 'win32': {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(local, 'ms-playwright', 'mcp-multi');
    }
    default:
      return path.join(os.homedir(), '.cache', 'ms-playwright', 'mcp-multi');
  }
}

function sanitizeName(name) {
  if (typeof name !== 'string' || !name.trim())
    throw new Error('Session name must be a non-empty string.');
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  if (!cleaned)
    throw new Error(`Session name "${name}" sanitizes to empty.`);
  return cleaned;
}

function profileDirFor(root, name) {
  return path.join(root, sanitizeName(name));
}

function isProfileLockedByOtherProcess(profileDir) {
  const lockPath = path.join(profileDir, 'SingletonLock');
  let target;
  try {
    target = fs.readlinkSync(lockPath);
  } catch (err) {
    if (err && err.code === 'ENOENT')
      return false;
    return fs.existsSync(lockPath);
  }
  const tail = target.split('-').pop();
  const pid = Number.parseInt(tail, 10);
  if (!Number.isFinite(pid) || pid <= 0)
    return true;
  if (pid === process.pid)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH')
      return false;
    return true;
  }
}

module.exports = {
  defaultProfileRoot,
  profileDirFor,
  sanitizeName,
  isProfileLockedByOtherProcess,
};
