import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { stringify } from 'yaml';
import { app } from './app.js';
import { parseModelsConfig } from './models.js';

test('example patch exposes the subagent tool in sdk-minimal', { timeout: 30000 }, async (t) => {
  let received: unknown;
  const server = createServer(async (request, reply) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received = JSON.parse(body);
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const part of [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
      reply.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, ...part }] })}\n\n`);
    }
    reply.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await app.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await app.ready();
  app.modelConfig = parseModelsConfig(stringify({ default: { provider: 'local', model: 'test-model' }, providers: {
    local: { baseUrl: `http://127.0.0.1:${address.port}/v1`, key: 'test', models: ['test-model'] },
  } }));
  const owner = await app.createWebHarness({ analysisOnly: true });
  const options = owner.harness.client.options;
  const harness = new DeepSeekHarness({ ...options, patches: [...(options.patches ?? []),
    fileURLToPath(new URL('../config/dsh-sandbox.example.patch.yml', import.meta.url)),
    fileURLToPath(new URL('../config/dsh-subagent.example.patch.yml', import.meta.url))] });
  t.after(async () => { await harness.close(); await owner.close(); });
  const result = await harness.run('Return ok.');
  assert.equal(result.finalResponse, 'ok');
  assert.ok(typeof received === 'object' && received !== null && 'tools' in received && Array.isArray(received.tools));
  assert.ok(received.tools.some((tool: { function?: { name?: string } }) => tool.function?.name === 'subagent'));
  assert.ok(!received.tools.some((tool: { function?: { name?: string } }) => ['web_fetch', 'bash', 'read'].includes(tool.function?.name ?? '')));
});
