/**
 * Copyright 2026 Zane St. John
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Minimal HTTP test server for the multi-session test suite. Inspired by the
 * upstream playwright-mcp test fixtures but trimmed down to what these tests
 * actually use (no HTTPS, no extra-headers, no CSP).
 */

import http from 'http';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export class TestServer {
  private _server: http.Server;
  private _routes = new Map<string, Handler>();
  readonly PORT: number;
  readonly PREFIX: string;
  readonly HELLO_WORLD: string;

  static async create(port: number): Promise<TestServer> {
    const server = new TestServer(port);
    await new Promise<void>(resolve => server._server.once('listening', () => resolve()));
    server.reset();
    return server;
  }

  private constructor(port: number) {
    this._server = http.createServer((req, res) => this._onRequest(req, res));
    this._server.listen(port);
    this.PORT = port;
    this.PREFIX = `http://localhost:${port}/`;
    this.HELLO_WORLD = `${this.PREFIX}hello-world`;
  }

  setContent(pathname: string, body: string, mimeType: string) {
    const route = pathname.startsWith('/') ? pathname : `/${pathname}`;
    this._routes.set(route, (req, res) => {
      res.writeHead(200, { 'Content-Type': mimeType });
      if (mimeType === 'text/html')
        res.end(`<!DOCTYPE html>${body}`);
      else
        res.end(body);
    });
  }

  reset() {
    this._routes.clear();
    this.setContent('/favicon.ico', '', 'image/x-icon');
    this.setContent('/', '', 'text/html');
    this.setContent('/hello-world', '<title>Title</title><body>Hello, world!</body>', 'text/html');
  }

  async stop() {
    await new Promise<void>((resolve, reject) =>
      this._server.close(err => (err ? reject(err) : resolve())));
  }

  private _onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const pathname = (req.url || '/').split('?')[0];
    const handler = this._routes.get(pathname);
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}
