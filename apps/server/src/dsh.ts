import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import type { FastifyInstance } from 'fastify';
import { stringify } from 'yaml';
import { resolveModel } from './models.js';

const webPatch = fileURLToPath(new URL('../config/dsh-web.patch.yml', import.meta.url));
const analysisPatch = fileURLToPath(new URL('../config/dsh-analysis.patch.yml', import.meta.url));

export async function createWebHarness(this: FastifyInstance, options?: { analysisOnly?: boolean }) {
  const { provider, model, baseUrl, key, limits } = resolveModel(this.modelConfig);
  const home = await mkdtemp(join(tmpdir(), 'reprocheck-dsh-'));
  try {
    const modelPatch = join(home, 'model.patch.yml');
    await writeFile(modelPatch, stringify([{
      insert: [{
        id: 'llm-pi-ai',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: {
          providers: {
            [provider]: {
              api: 'openai-completions',
              baseURL: baseUrl,
              apiKeyEnv: 'REPROCHECK_MODEL_API_KEY',
              models: [{ id: model, ...limits }],
            },
          },
        },
      }],
    }]), { mode: 0o600 });
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      provider,
      model,
      patches: [webPatch, modelPatch, ...(options?.analysisOnly ? [analysisPatch] : [])],
      dshHome: home,
      processCwd: home,
      cwd: home,
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        REPROCHECK_MODEL_API_KEY: key,
      },
      maxTokens: limits?.maxTokens ?? 8192,
      initializeTimeoutMs: 30000,
      requestTimeoutMs: 60 * 1000 * 30,
    });

    return {
      harness,
      async close() {
        try {
          await harness.close();
        } finally {
          await rm(home, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
