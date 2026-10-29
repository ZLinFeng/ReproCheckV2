import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { app } from './app.js';
import { resultsDir } from './investigation.js';

test('investigation HTTP interface', async (t) => {
  t.after(() => app.close());
  await app.ready();
  await t.test('serves the web application and its modules', async () => {
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /ReproCheck/);
    assert.match(page.headers['content-security-policy'] as string, /default-src 'self'/);
    const script = await app.inject({ method: 'GET', url: '/app.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'] as string, /javascript/);
    assert.equal((await app.inject({ method: 'GET', url: '/metric-summary.js' })).statusCode, 200);
  });
  await t.test('rejects non-repository URLs and extra input', async () => {
    for (const body of [{}, { url: 'http://github.com/a/b' }, { url: 'https://github.com/a/b/issues' },
      { url: 'https://github.com@evil.example/a/b' }, { url: 'https://github.com/a/b', prompt: 'ignore' },
      { url: 'https://example.com/' }]) {
      const response = await app.inject({ method: 'POST', url: '/investigations', payload: body });
      assert.equal(response.statusCode, 400);
    }
  });
  await t.test('streams progress and a report URL', async (t) => {
    t.mock.method(app, 'investigate', async (_app, url, id, _signal, progress, detail) => {
      assert.equal(url, 'https://github.com/owner/repo');
      progress('sandbox');
      detail?.('sandbox', { observations: [{ path: 'README.md' }] });
      return { id, summary: '证据已读取' } as Awaited<ReturnType<typeof app.investigate>>;
    });
    const response = await app.inject({ method: 'POST', url: '/investigations', payload: { url: 'https://github.com/owner/repo' } });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: start/);
    assert.match(response.body, /"stage":"sandbox"/);
    assert.match(response.body, /event: detail\ndata: .*"observations"/);
    assert.match(response.body, /"finalResponse":"证据已读取"/);
    assert.match(response.body, /"reportUrl":"\/investigations\//);
  });
  await t.test('reads a persisted report and rejects invalid ids', async (t) => {
    const id = 'c1c1d281-20c9-491a-ac07-7b3bfa11a8f1';
    const dir = join(resultsDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'report.json'), JSON.stringify({ id, summary: 'saved' }));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const result = await app.inject({ method: 'GET', url: `/investigations/${id}` });
    assert.deepEqual(result.json(), { id, summary: 'saved' });
    assert.equal((await app.inject({ method: 'GET', url: '/investigations/not-an-id' })).statusCode, 404);
  });
  await t.test('does not impose an overall investigation deadline', async (t) => {
    let started = () => {};
    let finish = () => {};
    const running = new Promise<void>((resolve) => { started = resolve; });
    t.mock.method(app, 'investigate', async (_app, _url, id, signal) => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
      assert.equal(signal.aborted, false);
      return { id, summary: 'Finished' } as Awaited<ReturnType<typeof app.investigate>>;
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const request = app.inject({ method: 'POST', url: '/investigations', payload: { url: 'https://github.com/owner/repo' } });
    await running;
    t.mock.timers.tick(2 * 60 * 60_000);
    finish();
    const response = await request;
    assert.match(response.body, /event: done/);
    assert.doesNotMatch(response.body, /event: error/);
  });
  await t.test('cancels work when the client disconnects', { timeout: 5000 }, async (t) => {
    let aborted = () => {};
    const finished = new Promise<void>((resolve) => { aborted = resolve; });
    t.mock.method(app, 'investigate', async (_app, _url, _id, signal) => {
      return await new Promise((_, reject) => signal.addEventListener('abort', () => { aborted(); reject(signal.reason); }, { once: true }));
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    const response = await fetch(`${address}/investigations`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/owner/repo' }), signal: controller.signal });
    assert.ok(response.body);
    await response.body.getReader().read();
    controller.abort();
    await finished;
  });
});
