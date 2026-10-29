import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { stringify } from 'yaml';
import { modelsPlugin, parseModelsConfig, resolveModel } from './models.js';

const first = { baseUrl: 'https://first.example.com/v1', key: 'first-secret', models: ['model-a', 'model-b'] };
const second = { baseUrl: 'https://second.example.com/v1', key: 'second-secret', models: ['model-c'] };
const config = {
  default: { provider: 'first', model: 'model-a' },
  providers: { first, second },
};

test('loads OpenAI-compatible endpoints, plaintext keys, models, and defaults', () => {
  const models = parseModelsConfig(stringify(config));
  assert.deepEqual(models.default, config.default);
  assert.deepEqual([...models.providers], [['first', first], ['second', second]]);
});

test('rejects invalid model configuration at load time', () => {
  for (const invalid of [
    null,
    [],
    {},
    { ...config, default: {} },
    { ...config, default: { provider: 'missing', model: 'model-a' } },
    { ...config, default: { provider: 'first', model: 'model-c' } },
    { ...config, providers: [] },
    { ...config, providers: { first: null } },
    { ...config, providers: { ' ': first } },
  ]) {
    assert.throws(() => parseModelsConfig(stringify(invalid)), /config\/models.yaml/);
  }
  for (const invalid of [
    { ...first, models: [] },
    { ...first, models: 'model-a' },
    { ...first, models: ['model-a', 123] },
    { ...first, models: ['model-a', '   '] },
    { ...first, baseUrl: '' },
    { ...first, baseUrl: 'not-a-url' },
    { ...first, baseUrl: 'https://' },
    { ...first, baseUrl: 'file:///etc/passwd' },
    { ...first, baseUrl: 123 },
    { ...first, key: undefined },
    { ...first, key: '' },
    { ...first, key: '   ' },
    { ...first, key: 123 },
    { ...first, modelLimits: { 'model-a': { contextWindow: 100, maxTokens: 101 } } },
    { ...first, modelLimits: { missing: { contextWindow: 100, maxTokens: 50 } } },
    { ...first, modelLimits: { 'model-a': { contextWindow: 100, maxTokens: 0 } } },
  ]) {
    assert.throws(() => parseModelsConfig(stringify({ ...config, providers: { first: invalid } })),
      /config\/models.yaml/);
  }
  assert.throws(() => parseModelsConfig('default: [unterminated'));
  assert.throws(() => parseModelsConfig('default: first\ndefault: second'));
});

test('resolves limits for the selected model', () => {
  const limits = { contextWindow: 1000000, maxTokens: 512000 };
  const models = parseModelsConfig(stringify({ ...config, providers: {
    first: { ...first, modelLimits: { 'model-a': limits } },
  } }));
  assert.deepEqual(resolveModel(models).limits, limits);
});

test('resolves the configured default provider endpoint, key, and model', () => {
  for (const [provider, settings] of Object.entries(config.providers)) {
    for (const model of settings.models) {
      const models = parseModelsConfig(stringify({ ...config, default: { provider, model } }));
      assert.deepEqual(resolveModel(models), {
        provider, model, baseUrl: settings.baseUrl, key: settings.key,
      });
    }
  }
});

test('models plugin exposes per-instance configuration to subsequent plugins', async (t) => {
  const app = Fastify();
  const other = Fastify();
  t.after(() => app.close());
  t.after(() => other.close());
  assert.equal(app.hasDecorator('modelConfig'), false);
  app.register(modelsPlugin);
  other.register(modelsPlugin);
  app.register(async (instance) => {
    assert.ok(instance.hasDecorator('modelConfig'));
    const model = resolveModel(instance.modelConfig);
    assert.equal(model.provider, instance.modelConfig.default.provider);
    assert.equal(model.model, instance.modelConfig.default.model);
  });
  await app.ready();
  await other.ready();
  assert.ok(app.hasDecorator('modelConfig'));
  assert.notEqual(app.modelConfig, other.modelConfig);
  assert.deepEqual(app.modelConfig, other.modelConfig);
});
