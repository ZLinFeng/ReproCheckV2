import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { stringify } from 'yaml';
import { app } from './app.js';
import { parseModelsConfig } from './models.js';

const provider = 'local-test';
const model = 'test-model';
const selection = { provider, model };

test('investigations uses OpenAI chat completions and rejects private fetches', { timeout: 30000 }, async (t) => {
  const requests: { url: string | undefined; authorization: string | undefined; body: unknown }[] = [];
  const server = createServer(async (request, reply) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload: unknown = JSON.parse(body);
    requests.push({ url: request.url, authorization: request.headers.authorization, body: payload });
    const toolCall = requests.length === 1;
    const chunks = [
      { delta: { role: 'assistant' }, finish_reason: null },
      {
        delta: toolCall
          ? { tool_calls: [{ index: 0, id: 'call_fetch', type: 'function', function: {
            name: 'web_fetch', arguments: '{"url":"http://127.0.0.1:9/"}',
          } }] }
          : { content: 'test response' },
        finish_reason: null,
      },
      { delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' },
    ];
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) {
      reply.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model,
        choices: [{ index: 0, ...chunk }],
      })}\n\n`);
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
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const key = 'local-test-secret';
  const config = parseModelsConfig(stringify({
    default: selection,
    providers: { [provider]: { baseUrl, key, models: [model], modelLimits: {
      [model]: { contextWindow: 1000000, maxTokens: 512000 },
    } } },
  }));
  await app.ready();
  app.modelConfig = config;
  const dsh = await app.createWebHarness();
  t.after(() => dsh.close());

  const home = dsh.harness.client.options.dshHome;
  assert.ok(home);
  const patch = readFileSync(`${home}/model.patch.yml`, 'utf8');
  assert.ok(!patch.includes(key));
  const env = dsh.harness.client.options.env;
  assert.equal(env?.REPROCHECK_MODEL_API_KEY, key);
  assert.ok(!Object.keys(env ?? {}).some((name) => name.startsWith('DEEPSEEK_')));

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      dsh.harness.run('Fetch https://example.com/paper'),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Harness test timed out')), 20000);
      }),
    ]);
    assert.equal(result.finalResponse, 'test response');
    assert.ok(!result.finalResponse.includes(key));
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.authorization, `Bearer ${key}`);
    }
    const first = requests[0].body;
    assert.ok(typeof first === 'object' && first !== null && 'tools' in first && Array.isArray(first.tools));
    assert.ok('model' in first);
    assert.equal(first.model, model);
    assert.ok('max_tokens' in first || 'max_completion_tokens' in first);
    assert.equal('max_tokens' in first ? first.max_tokens : first.max_completion_tokens, 512000);
    const toolNames = first.tools.map((tool: unknown) => {
      if (typeof tool !== 'object' || tool === null || !('function' in tool)) return undefined;
      const definition = tool.function;
      if (typeof definition !== 'object' || definition === null || !('name' in definition)) return undefined;
      return definition.name;
    });
    assert.deepEqual(toolNames, ['web_fetch']);
    assert.match(JSON.stringify(requests[1].body), /non-public IP address/);
  } finally {
    clearTimeout(timer);
    await dsh.close();
  }
  assert.equal(existsSync(home), false);
});
