import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createServer } from '../src/server.ts';
import type { Config } from '../src/config.ts';

const config: Config = {
  port: 0,
  dataDir: path.join(process.cwd(), 'data'),
  publicUrl: 'http://127.0.0.1:0',
};

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.setTimeout(5000, () => socket.destroy(new Error('raw request timed out')));
  });
}

test('a malformed request target answers 400 and leaves the server serving', async () => {
  const server = await createServer({ config });
  try {
    const port = Number(new URL(server.url).port);
    const response = await rawRequest(
      port,
      'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    );
    assert.match(response, /^HTTP\/1\.1 400 /u);
    assert.match(response, /invalid_request_target/u);

    const health = await fetch(`${server.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
  } finally {
    await server.close();
  }
});
