import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Terminates test HTTPS locally; no DNS lookup or upstream connection is possible. */
export async function createHttpsProxy(origins: string[], fetch: (request: Request) => Promise<Response>) {
  // Ephemeral test key/certificate, removed immediately after reading.
  const directory = mkdtempSync(join(tmpdir(), 'auth-browser-tls-'));
  let tls: { key: Buffer; cert: Buffer };
  try {
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=auth-browser-fixture', '-keyout', key, '-out', cert,
    ], { stdio: 'ignore' });
    tls = { key: readFileSync(key), cert: readFileSync(cert) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const failures: Error[] = [];
  const sockets = new Set<Socket>();
  const secure = createHttpsServer(tls, async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `https://${request.headers.host}`);
      if (!origins.includes(url.origin)) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        headers.append(request.rawHeaders[i], request.rawHeaders[i + 1]);
      }
      const result = await fetch(new Request(url, {
        method: request.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }));
      for (const [name, value] of result.headers) {
        if (name !== 'set-cookie') response.setHeader(name, value);
      }
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader('set-cookie', cookies);
      response.writeHead(result.status).end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(500).end();
    }
  });
  const proxy = createHttpServer((_request, response) => response.writeHead(403).end());
  proxy.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('connect', (request, socket, head) => {
    if (!origins.some(origin => `${new URL(origin).hostname}:443` === request.url)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    secure.emit('connection', socket);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing local proxy address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    failures,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    },
  };
}
