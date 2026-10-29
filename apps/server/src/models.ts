import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fp from 'fastify-plugin';
import { parse } from 'yaml';

declare module 'fastify' {
  interface FastifyInstance {
    modelConfig: ReturnType<typeof parseModelsConfig>;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseModelsConfig(source: string) {
  const config: unknown = parse(source);
  assert.ok(isRecord(config) && isRecord(config.default) && isRecord(config.providers),
    'config/models.yaml 必须包含 default 和 providers');
  const { provider, model } = config.default;
  assert.ok(typeof provider === 'string' && typeof model === 'string',
    'config/models.yaml 的 default 必须包含 provider 和 model 字符串');

  const providers = new Map<string, { baseUrl: string; key: string; models: string[]; modelLimits?: Record<string, { contextWindow: number; maxTokens: number }> }>();
  for (const [name, entry] of Object.entries(config.providers)) {
    assert.ok(name.trim() && isRecord(entry) && Array.isArray(entry.models)
      && entry.models.length > 0
      && entry.models.every((value: unknown): value is string => typeof value === 'string' && !!value.trim()),
    `config/models.yaml 的 providers.${name}.models 必须是非空模型列表`);
    assert.ok(typeof entry.baseUrl === 'string' && /^https?:\/\//.test(entry.baseUrl)
      && URL.canParse(entry.baseUrl),
    `config/models.yaml 的 providers.${name}.baseUrl 必须是 HTTP(S) 地址`);
    assert.ok(typeof entry.key === 'string' && entry.key.trim(),
      `config/models.yaml 的 providers.${name}.key 必须是非空字符串`);
    let modelLimits: Record<string, { contextWindow: number; maxTokens: number }> | undefined;
    if (entry.modelLimits !== undefined) {
      assert.ok(isRecord(entry.modelLimits), `config/models.yaml 的 providers.${name}.modelLimits 必须是对象`);
      modelLimits = Object.create(null);
      for (const [id, limits] of Object.entries(entry.modelLimits)) {
        assert.ok(entry.models.includes(id) && isRecord(limits)
          && Number.isSafeInteger(limits.contextWindow) && (limits.contextWindow as number) > 0
          && Number.isSafeInteger(limits.maxTokens) && (limits.maxTokens as number) > 0
          && (limits.maxTokens as number) <= (limits.contextWindow as number),
        `config/models.yaml 的 providers.${name}.modelLimits.${id} 必须包含有效的 contextWindow 和 maxTokens`);
        modelLimits![id] = { contextWindow: limits.contextWindow as number, maxTokens: limits.maxTokens as number };
      }
    }
    providers.set(name, { baseUrl: entry.baseUrl, key: entry.key, models: entry.models, ...(modelLimits ? { modelLimits } : {}) });
  }
  assert.ok(providers.get(provider)?.models.includes(model),
    'config/models.yaml 的默认 Provider/Model 必须在 providers 中配置');
  return { default: { provider, model }, providers };
}

export const modelsPlugin = fp(async (app) => {
  const config = parseModelsConfig(readFileSync(new URL('../config/models.yaml', import.meta.url), 'utf8'));
  app.decorate('modelConfig', config);
}, { name: 'models', fastify: '5.x' });

export function resolveModel(config: ReturnType<typeof parseModelsConfig>) {
  const { provider, model } = config.default;
  const settings = config.providers.get(provider);
  if (!settings?.models.includes(model)) {
    throw new Error('Provider/Model 未在 config/models.yaml 中配置');
  }
  return { provider, model, baseUrl: settings.baseUrl, key: settings.key, ...(settings.modelLimits?.[model] ? { limits: settings.modelLimits[model] } : {}) };
}
