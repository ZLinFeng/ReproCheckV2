import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.js';

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

export async function runBenchmark(root: string, benchmark: Benchmark, signal?: AbortSignal,
  model?: { baseUrl: string; key: string; model: string; limits?: { contextWindow: number; maxTokens: number } },
  copyRepository = true) {
  const name = `reprocheck-${randomUUID()}`;
  const network = `${name}-network`;
  const proxy = `${name}-proxy`;
  const image = benchmark.runtime === 'python' ? 'python:3.12-alpine' : 'node:22-alpine';
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  const common = { cwd: root, env, signal, timeoutMs: 15000, maxBytes: 250_000 };
  let secretDir: string | undefined;
  try {
    const pi = benchmark.agent ? await findPi() : null;
    if (benchmark.agent && !pi) return { status: 'unavailable' as const, error: 'A supported local Pi CLI was not found.' };
    if (benchmark.model && (!model || !URL.canParse(model.baseUrl) || new URL(model.baseUrl).protocol !== 'https:')) {
      return { status: 'unavailable' as const, error: 'The configured model service is unavailable; a public HTTPS OpenAI-compatible endpoint is required.' };
    }
    const inspected = await runProcess('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], common);
    const imageId = inspected.stdout.trim();
    if (inspected.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId)) return { status: 'unavailable' as const, error: 'The local runtime image was not found.' };
    if (benchmark.network) {
      const proxyImage = await runProcess('docker', ['image', 'inspect', 'node:22-alpine', '--format', '{{.Id}}'], common);
      const proxyImageId = proxyImage.stdout.trim();
      if (proxyImage.code !== 0 || !/^sha256:[a-f0-9]{64}$/.test(proxyImageId)) return { status: 'unavailable' as const, error: 'Networked experiments require a local node:22-alpine proxy image.' };
      const networkResult = await runProcess('docker', ['network', 'create', '--internal', network], common);
      if (networkResult.code !== 0) return { status: 'unavailable' as const, error: 'Could not create the isolated network.' };
      const proxyScript = fileURLToPath(new URL('../config/egress-proxy.cjs', import.meta.url));
      const hostAddresses = Object.values(networkInterfaces()).flatMap((items) => (items || []).map((item) => item.address.split('%')[0]));
      let modelMount: string[] = [];
      if (benchmark.model && model) {
        secretDir = await mkdtemp(join(tmpdir(), 'reprocheck-model-'));
        const secretPath = join(secretDir, 'model.json');
        await writeFile(secretPath, JSON.stringify({ baseUrl: model.baseUrl, key: model.key, model: model.model }), { mode: 0o444 });
        modelMount = ['--env', 'MODEL_CONFIG=/model.json', '--mount', `type=bind,src=${secretPath},dst=/model.json,readonly`];
      }
      const proxyArgs = ['create', '--name', proxy, '--pull=never', '--network', network, '--network-alias', 'egress',
        '--read-only', '--log-driver=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
        '--memory=128m', '--cpus=0.5', '--user=65534:65534', '--env', `HOST_ADDRESSES=${JSON.stringify(hostAddresses)}`,
        '--mount', `type=bind,src=${proxyScript},dst=/proxy.cjs,readonly`, ...modelMount,
        '--entrypoint', 'node', proxyImageId, '/proxy.cjs'];
      const createdProxy = await runProcess('docker', proxyArgs, common);
      if (createdProxy.code !== 0) return { status: 'unavailable' as const, error: 'Could not create the network egress proxy.' };
      const startedProxy = await runProcess('docker', ['start', proxy], common);
      if (startedProxy.code !== 0) return { status: 'unavailable' as const, error: 'Could not start the network egress proxy.' };
      const connected = await runProcess('docker', ['network', 'connect', 'bridge', proxy], common);
      if (connected.code !== 0) return { status: 'unavailable' as const, error: 'Could not connect the network egress proxy.' };
      const ready = await runProcess('docker', ['exec', proxy, 'node', '-e',
        `const net=require('net'),os=require('os');const ip=(os.networkInterfaces().eth0||[]).find(x=>x.family==='IPv4')?.address;let n=0;function check(){const s=net.connect(3128,ip);s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>{if(++n===30)process.exit(1);setTimeout(check,100)})}check()`], common);
      if (ready.code !== 0 || ready.timedOut) return { status: 'unavailable' as const, error: 'The network egress proxy is not ready.' };
    }
    const proxyEnv = benchmark.network ? ['--env', 'HTTP_PROXY=http://egress:3128', '--env', 'HTTPS_PROXY=http://egress:3128',
      '--env', 'http_proxy=http://egress:3128', '--env', 'https_proxy=http://egress:3128', '--env', 'NO_PROXY=egress', '--env', 'no_proxy=egress'] : [];
    const modelEnv = benchmark.model && model ? ['--env', `REPROCHECK_MODEL_ID=${model.model}`,
      '--env', 'REPROCHECK_MODEL_BASE_URL=http://egress:3128/reprocheck-model/v1', '--env', 'REPROCHECK_MODEL_API_KEY=local'] : [];
    const piMount = pi ? ['--mount', `type=bind,src=${pi.root},dst=/opt/reprocheck-pi,readonly`,
      '--env', 'PATH=/work/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', '--env', 'PI_CODING_AGENT_DIR=/work/pi-agent'] : [];
    const piSetup = pi ? `mkdir -p /work/bin /work/pi-agent && printf '#!/bin/sh\nexec node /opt/reprocheck-pi/dist/bundle/cli.js "$@"\n' > /work/bin/pi && chmod 755 /work/bin/pi && ` : '';
    const modelSetup = benchmark.agent && benchmark.model && model ? `node -e 'require("fs").writeFileSync("/work/pi-agent/models.json",JSON.stringify({providers:{reprocheck:{baseUrl:process.env.REPROCHECK_MODEL_BASE_URL,api:"openai-completions",apiKey:"local",models:[{id:process.env.REPROCHECK_MODEL_ID,contextWindow:${model.limits?.contextWindow ?? 128000},maxTokens:${model.limits?.maxTokens ?? 8192}}]}}}))' && ` : '';
    const args = ['create', '--name', name, '--pull=never', '--network', benchmark.network ? network : 'none',
      ...(benchmark.network ? ['--dns', '127.0.0.1'] : []), '--read-only', '--log-driver=none',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=1536m', '--cpus=1',
      '--user=65534:65534', '--env', 'HOME=/work', ...proxyEnv, ...modelEnv, ...piMount, '--tmpfs', '/work:rw,exec,nosuid,nodev,size=1g,nr_inodes=131072,mode=1777',
      ...(copyRepository ? ['--mount', `type=bind,src=${root},dst=/source,readonly`] : []), '--workdir', '/work', '--entrypoint', '/bin/sh', imageId,
      '-c', `/bin/sh -n -c "$1" || exit $?; ${piSetup}${modelSetup}${copyRepository ? 'mkdir /work/repository && cp -R /source/. /work/repository/ && cd /work/repository && ' : ''}exec /bin/sh -c "$1"`,
      'reprocheck', benchmark.command];
    const created = await runProcess('docker', args, common);
    if (created.code !== 0 || created.timedOut) return { status: 'unavailable' as const, error: 'Could not create the isolated container; check Docker and the local runtime image.' };
    const started = Date.now();
    const result = await runProcess('docker', ['start', '--attach', name], { ...common, timeoutMs: 300000 });
    const redact = (value: string) => benchmark.model && model?.key ? value.split(model.key).join('[redacted]') : value;
    const output = { image, imageId, network: benchmark.network ? 'public-proxy' : 'none',
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
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'unavailable' as const, error: 'Docker was not found.' };
    return { status: 'failed' as const, error: error instanceof Error ? error.message : 'Container execution failed.' };
  } finally {
    await runProcess('docker', ['rm', '-f', name], { cwd: root, env, timeoutMs: 15000, maxBytes: 5000 }).catch(() => {});
    if (benchmark.network) {
      await runProcess('docker', ['rm', '-f', proxy], { cwd: root, env, timeoutMs: 15000, maxBytes: 5000 }).catch(() => {});
      await runProcess('docker', ['network', 'rm', network], { cwd: root, env, timeoutMs: 15000, maxBytes: 5000 }).catch(() => {});
    }
    if (secretDir) await rm(secretDir, { recursive: true, force: true }).catch(() => {});
  }
}
