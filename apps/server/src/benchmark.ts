import { arch, platform, release, tmpdir } from 'node:os';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { classifyRunnerFailure, isRunnerSpawnFailure } from '@deepseek-ai/dsh-sandbox';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { runProcess } from './process.js';
import { sandbox } from './sandbox.js';

export type Benchmark = {
  runtime: 'python' | 'node';
  network: boolean;
  agent?: boolean;
  model?: boolean;
  command: string;
  metric: string;
  unit: string;
  comparison: 'lt' | 'lte' | 'eq' | 'gte' | 'gt' | null;
  expected: number | null;
  basis: string;
};

export type BenchmarkProgress = { task: string; status: 'completed' | 'failed' | 'timed_out'; arms?: object };

export function parseBenchmark(value: unknown): Benchmark | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The model returned an invalid execution plan.');
  const item = value as Record<string, unknown>;
  const validText = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && v.length <= max;
  if (!['python', 'node'].includes(String(item.runtime)) || typeof item.network !== 'boolean'
    || (item.agent !== undefined && typeof item.agent !== 'boolean') || (item.model !== undefined && typeof item.model !== 'boolean')
    || ((item.agent || item.model) && !item.network) || (item.agent && item.runtime !== 'node') || !validText(item.command, 16000)
    || !validText(item.metric, 200) || !validText(item.unit, 100) || !validText(item.basis, 2000)
    || !((item.comparison === null && item.expected === null)
      || (['lt', 'lte', 'eq', 'gte', 'gt'].includes(String(item.comparison))
        && typeof item.expected === 'number' && Number.isFinite(item.expected)))) throw new Error('The model returned an invalid execution plan.');
  return item as Benchmark;
}

export async function findPi() {
  try {
    const result = await runProcess('which', ['pi'], { cwd: tmpdir(), env: { PATH: process.env.PATH }, timeoutMs: 5000 });
    if (result.code !== 0) return null;
    const entry = await realpath(result.stdout.trim());
    const root = join(dirname(entry), '../..');
    const info = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (info.name !== '@earendil-works/pi-coding-agent' || !/^\d+\.\d+\.\d+$/.test(info.version)) return null;
    return { root, version: info.version };
  } catch { return null; }
}

const require = createRequire(import.meta.url);
const { createProxy } = require('../config/egress-proxy.cjs') as { createProxy: (model?: { baseUrl: string; key: string; model: string }) => Server };

export async function hostCapabilities(signal?: AbortSignal) {
  const env = { PATH: process.env.PATH };
  const tools: Record<string, { path: string; version: string } | null> = {};
  for (const name of ['node', 'npm', 'python', 'python3', 'pip', 'git', 'curl']) {
    try {
      const found = await runProcess('which', [name], { cwd: tmpdir(), env, signal, timeoutMs: 5000, maxBytes: 2000 });
      if (found.code !== 0) { tools[name] = null; continue; }
      const path = found.stdout.trim().split('\n')[0];
      const version = await runProcess(path, ['--version'], { cwd: tmpdir(), env, signal, timeoutMs: 5000, maxBytes: 2000 });
      tools[name] = { path, version: (version.stdout || version.stderr).trim().split('\n')[0].slice(0, 200) };
    } catch { if (signal?.aborted) throw signal.reason; tools[name] = null; }
  }
  return { platform: platform(), release: release(), architecture: arch(), tools };
}

export async function runBenchmark(root: string, benchmark: Benchmark, signal?: AbortSignal,
  model?: { baseUrl: string; key: string; model: string; limits?: { contextWindow: number; maxTokens: number } },
  copyRepository = true, onInterrupted?: (output: { stdout: string; stderr: string }) => void,
  onProgress?: (progress: BenchmarkProgress) => void, publicSearchProxy = false) {
  let workspace: string | undefined;
  let proxy: Server | undefined;
  try {
    const pi = benchmark.agent ? await findPi() : null;
    if (benchmark.agent && !pi) return { status: 'unavailable' as const, error: 'A supported local Pi CLI was not found.' };
    if (benchmark.model && (!model || !URL.canParse(model.baseUrl) || !['http:', 'https:'].includes(new URL(model.baseUrl).protocol))) {
      return { status: 'unavailable' as const, error: 'The configured model service is unavailable; an HTTP(S) OpenAI-compatible endpoint is required.' };
    }
    const capabilities = await hostCapabilities(signal);
    const python = capabilities.tools.python || capabilities.tools.python3;
    if (benchmark.runtime === 'python' && !python) return { status: 'unavailable' as const, error: 'Python was not found on the host.' };
    if (benchmark.runtime === 'node' && !capabilities.tools.node) return { status: 'unavailable' as const, error: 'Node.js was not found on the host.' };
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'reprocheck-run-')));
    const bin = join(workspace, 'bin');
    const home = join(workspace, 'home');
    const cwd = copyRepository ? join(workspace, 'repository') : workspace;
    await mkdir(bin);
    await mkdir(home);
    if (copyRepository) await cp(root, cwd, { recursive: true, verbatimSymlinks: true });
    if (!capabilities.tools.python && python) await symlink(python.path, join(bin, 'python'));
    const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH || '/usr/bin:/bin'}`, HOME: home,
      TMPDIR: workspace, LANG: 'C.UTF-8', REPROCHECK_WORKSPACE: workspace, NO_PROXY: '*', no_proxy: '*' };
    if ((benchmark.model && model) || publicSearchProxy) {
      proxy = createProxy(benchmark.model ? model : undefined);
      await new Promise<void>((resolve, reject) => { proxy!.once('error', reject); proxy!.listen(0, '127.0.0.1', resolve); });
      const address = proxy.address();
      if (!address || typeof address === 'string') throw new Error('Model proxy did not start.');
      const proxyUrl = `http://127.0.0.1:${address.port}`;
      if (publicSearchProxy) Object.assign(env, { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' });
      if (benchmark.model && model) {
        env.REPROCHECK_MODEL_ID = model.model;
        env.REPROCHECK_MODEL_BASE_URL = `${proxyUrl}/reprocheck-model/v1`;
        env.REPROCHECK_MODEL_API_KEY = 'local';
      }
    }
    if (pi) {
      env.PI_CODING_AGENT_DIR = join(workspace, 'pi-agent');
      await mkdir(env.PI_CODING_AGENT_DIR);
      if (benchmark.model && model) await writeFile(join(env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({
        providers: { reprocheck: { baseUrl: env.REPROCHECK_MODEL_BASE_URL, api: 'openai-completions', apiKey: 'local',
          models: [{ id: model.model, contextWindow: model.limits?.contextWindow ?? 128000, maxTokens: model.limits?.maxTokens ?? 8192 }] } },
      }));
    }
    const confined = await sandbox.confine(['/bin/sh', '-c', benchmark.command], { mode: 'workspace-write', workspaceRoot: workspace }, signal);
    const started = Date.now();
    const redact = (value: string) => benchmark.model && model?.key ? value.split(model.key).join('[redacted]') : value;
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const progressChunk = (chunk: Buffer) => {
      if (!onProgress) return;
      pending += decoder.write(chunk);
      const lines = pending.split('\n');
      pending = (lines.pop() || '').slice(-8192);
      for (const line of lines) {
        if (!line.startsWith('REPROCHECK_PROGRESS ') || line.length > 8192) continue;
        try {
          const item: unknown = JSON.parse(redact(line.slice('REPROCHECK_PROGRESS '.length)));
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const entry = item as Record<string, unknown>;
          if (typeof entry.task !== 'string' || !entry.task.trim() || entry.task.length > 200
            || !['completed', 'failed', 'timed_out'].includes(String(entry.status))
            || (entry.arms !== undefined && (!entry.arms || typeof entry.arms !== 'object' || Array.isArray(entry.arms)))) continue;
          onProgress({ task: entry.task, status: entry.status as BenchmarkProgress['status'], ...(entry.arms ? { arms: entry.arms as object } : {}) });
        } catch { /* Progress is untrusted; malformed lines remain in the execution log. */ }
      }
    };
    let result;
    try {
      result = await runProcess(confined.argv[0], confined.argv.slice(1), { cwd, env, signal, timeoutMs: 30 * 60_000, maxBytes: 250_000,
        onAbortOutput: (output) => onInterrupted?.({ stdout: redact(output.stdout), stderr: redact(output.stderr) }), onStderr: progressChunk });
    } catch (error) {
      if (isRunnerSpawnFailure(error, confined.argv[0], cwd)) return { status: 'unavailable' as const, error: 'The DSH sandbox runner could not be started.' };
      throw error;
    }
    if (result.code !== 0 && classifyRunnerFailure(result.code, result.stderr, confined.runnerFailureRules)) {
      return { status: 'unavailable' as const, error: 'The DSH sandbox runner could not enforce its policy.' };
    }
    const output = { environment: { ...capabilities, sandbox: { provider: 'dsh-local', mode: 'workspace-write',
      enforcement: confined.enforcement }, network: 'host-unrestricted', networkRequested: benchmark.network },
      ...(pi ? { agent: { name: 'pi', version: pi.version } } : {}), ...(benchmark.model && model ? { model: model.model } : {}),
      elapsedMs: Date.now() - started, stdout: redact(result.stdout), stderr: redact(result.stderr), exitCode: result.code, timedOut: result.timedOut };
    if (result.timedOut || result.code !== 0) return { status: 'failed' as const, ...output };
    let actual: unknown;
    try { actual = (JSON.parse(output.stdout) as { value?: unknown }).value; } catch { /* command must emit a single JSON value */ }
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return { status: 'invalid_output' as const, ...output };
    const expected = benchmark.expected;
    const matched = benchmark.comparison === null || expected === null ? null :
      { lt: actual < expected, lte: actual <= expected, eq: actual === expected,
        gte: actual >= expected, gt: actual > expected }[benchmark.comparison];
    return { status: 'measured' as const, actual, matched, ...output };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if ((error as { code?: string })?.code === 'SANDBOX_UNAVAILABLE') return { status: 'unavailable' as const, error: 'The DSH sandbox is unavailable on this host.' };
    return { status: 'failed' as const, error: error instanceof Error ? error.message : 'Host execution failed.' };
  } finally {
    if (proxy) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy!.close(() => resolve())); }
    if (workspace) await rm(workspace, { recursive: true, force: true });
  }
}
