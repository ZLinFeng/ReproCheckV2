import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { isPublic, createProxy } = require('../config/egress-proxy.cjs') as {
  isPublic: (address: string) => boolean;
  createProxy: (model?: { baseUrl: string; key: string; model: string }) => http.Server;
};

test('public address policy rejects private, metadata, mapped and reserved addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.31.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '198.18.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '2001:db8::1']) {
    assert.equal(isPublic(address), false, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublic(address), true, address);
});

test('model gateway only accepts the configured model and does not expose its key', async (t) => {
  const proxy = createProxy({ baseUrl: 'https://example.com/v1', model: 'allowed-model', key: 'secret-test-key' });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const port = (proxy.address() as { port: number }).port;
  const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/reprocheck-model/v1/chat/completions',
      headers: { 'content-type': 'application/json' } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ model: 'different-model', messages: [] }));
  });
  assert.equal(result.status, 403);
  assert.doesNotMatch(result.body, /secret-test-key/);
});

test('proxy denies HTTP and CONNECT requests to private destinations', async (t) => {
  const proxy = createProxy();
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const port = (proxy.address() as { port: number }).port;
  for (const method of ['GET', 'CONNECT']) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, method,
        path: method === 'CONNECT' ? '169.254.169.254:80' : 'http://127.0.0.1:80/' });
      request.on('response', (response) => { response.resume(); resolve(response.statusCode); });
      request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 403);
  }
});
