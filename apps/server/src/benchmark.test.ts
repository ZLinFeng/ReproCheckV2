import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import { findPi, parseBenchmark, runBenchmark } from './benchmark.js';
import { sandbox } from './sandbox.js';

const benchmark = { runtime: 'python' as const, network: false, command: '', metric: 'example', unit: 'count', comparison: 'eq' as const, expected: 3, basis: 'fixture' };

test('validates executable plans', () => {
  assert.equal(parseBenchmark(null), null);
  assert.throws(() => parseBenchmark({ ...benchmark, runtime: 'unknown', command: 'echo' }));
  assert.throws(() => parseBenchmark({ ...benchmark, expected: Infinity, command: 'echo' }));
  assert.throws(() => parseBenchmark({ ...benchmark, command: '' }));
  assert.throws(() => parseBenchmark({ ...benchmark, network: 'yes', command: 'echo' }));
  assert.throws(() => parseBenchmark({ ...benchmark, agent: true, command: 'echo' }));
  assert.throws(() => parseBenchmark({ ...benchmark, network: true, agent: true, command: 'echo' }));
  assert.throws(() => parseBenchmark({ ...benchmark, model: true, command: 'echo' }));
  assert.ok(parseBenchmark({ ...benchmark, command: 'x'.repeat(16000) }));
  assert.throws(() => parseBenchmark({ ...benchmark, command: 'x'.repeat(16001) }));
  assert.deepEqual(parseBenchmark({ ...benchmark, command: 'echo', comparison: null, expected: null }),
    { ...benchmark, command: 'echo', comparison: null, expected: null });
  assert.throws(() => parseBenchmark({ ...benchmark, command: 'echo', comparison: null }));
  assert.throws(() => parseBenchmark({ ...benchmark, command: 'echo', expected: null }));
});

test('runs the host runtime through the DSH sandbox in a temporary copy', { skip: process.platform !== 'darwin' && process.platform !== 'linux', timeout: 30000 }, async (t) => {
  const parent = await mkdtemp(join(process.cwd(), 'reprocheck-test-'));
  const root = join(parent, 'source');
  await mkdir(root);
  const outside = join(parent, 'outside.txt');
  await writeFile(join(root, 'data.txt'), 'abc');
  await writeFile(outside, 'protected');
  t.after(() => rm(parent, { recursive: true, force: true }));
  const command = `node -e 'const fs=require("fs"),cp=require("child_process");const p="data.txt";const n=fs.readFileSync(p,"utf8").length;fs.writeFileSync(p,"changed");const child=cp.spawnSync(process.execPath,["-e", ${JSON.stringify('require("fs").writeFileSync(process.argv[1],"bad")')},${JSON.stringify(outside)}]);if(child.status===0)process.exit(2);console.log(JSON.stringify({value:n,workspace:process.env.REPROCHECK_WORKSPACE}))'`;
  const result = await runBenchmark(root, { ...benchmark, runtime: 'node', command });
  assert.equal(result.status, 'measured', JSON.stringify(result));
  if (result.status !== 'measured') return;
  assert.equal(result.actual, 3);
  assert.equal(result.matched, true);
  assert.equal(result.environment.sandbox.provider, 'dsh-local');
  assert.equal(result.environment.network, 'host-unrestricted');
  assert.equal(await readFile(join(root, 'data.txt'), 'utf8'), 'abc');
  assert.equal(await readFile(outside, 'utf8'), 'protected');
  await assert.rejects(stat(JSON.parse(result.stdout).workspace), { code: 'ENOENT' });

  const failed = await runBenchmark(root, { ...benchmark, runtime: 'node', command: 'exit 7' });
  assert.equal(failed.status, 'failed');
  if (failed.status === 'failed' && 'exitCode' in failed) assert.equal(failed.exitCode, 7);
  const invalid = await runBenchmark(root, { ...benchmark, runtime: 'node', command: 'echo not-json' });
  assert.equal(invalid.status, 'invalid_output');
  const exploratory = await runBenchmark(root, { ...benchmark, runtime: 'node', command: `echo '{"value":3}'`, comparison: null, expected: null });
  assert.equal(exploratory.status, 'measured');
  if (exploratory.status === 'measured') assert.equal(exploratory.matched, null);
});

test('does not pass host proxy settings to experiments', { skip: process.platform !== 'darwin' && process.platform !== 'linux', timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-direct-network-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
  const previous = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
  }));
  names.forEach((name) => { process.env[name] = 'http://127.0.0.1:7890'; });
  const command = `node -e 'const names=["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy"];console.log(JSON.stringify({value:names.every(n=>!process.env[n])&&process.env.NO_PROXY==="*"&&process.env.no_proxy==="*"?1:0}))'`;
  const result = await runBenchmark(root, { ...benchmark, runtime: 'node', network: true, command, expected: 1 });
  assert.equal(result.status, 'measured', JSON.stringify(result));
  if (result.status === 'measured') assert.equal(result.matched, true);
});

test('reports progress and cleans up after cancellation', { skip: process.platform !== 'darwin' && process.platform !== 'linux', timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-benchmark-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let interruptedLog = '';
  let observedWorkspace = '';
  const command = `printf 'workspace=%s\\n' "$REPROCHECK_WORKSPACE" >&2; printf '%s\\n' 'REPROCHECK_PROGRESS {"task":"one","status":"completed"}' >&2; sleep 30`;
  const result = runBenchmark(root, { ...benchmark, runtime: 'node', command }, controller.signal, undefined, true,
    (output) => { interruptedLog = output.stderr; }, () => controller.abort(new Error('cancelled')));
  await assert.rejects(result, /cancelled/);
  observedWorkspace = /workspace=([^\n]+)/.exec(interruptedLog)?.[1] || '';
  assert.ok(observedWorkspace);
  await assert.rejects(stat(observedWorkspace), { code: 'ENOENT' });
});


test('uses the host Pi with temporary model configuration and a local gateway', { skip: !(await findPi()), timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-pi-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `const fs=require("fs"),http=require("http");const c=JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR+"/models.json"));if(c.providers.reprocheck.apiKey!=="local"||process.env.REPROCHECK_MODEL_API_KEY!=="local"||JSON.stringify(process.env).includes("secret-test-key"))process.exit(2);const r=http.request(process.env.REPROCHECK_MODEL_BASE_URL+"/chat/completions",{method:"POST"},res=>{res.resume();res.on("end",()=>console.log(JSON.stringify({value:res.statusCode}))) });r.on("error",()=>process.exit(3));r.end(JSON.stringify({model:"wrong"}));`;
  const result = await runBenchmark(root, { ...benchmark, runtime: 'node', network: true, agent: true, model: true, expected: 403,
    command: `pi --version >&2 && node -e '${script}'` }, undefined,
    { baseUrl: 'https://example.com/v1', key: 'secret-test-key', model: 'test-model' });
  assert.equal(result.status, 'measured', JSON.stringify(result));
  if (result.status === 'measured') {
    assert.equal(result.matched, true);
    assert.equal(result.agent?.name, 'pi');
    assert.equal(result.model, 'test-model');
    assert.ok(!JSON.stringify(result).includes('secret-test-key'));
  }
});

test('uses the configured private HTTP model endpoint through the model gateway', { skip: process.platform !== 'darwin' && process.platform !== 'linux', timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-model-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer secret-test-key');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"value":3}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const port = (upstream.address() as { port: number }).port;
  const command = `node -e 'const http=require("http");const r=http.request(process.env.REPROCHECK_MODEL_BASE_URL+"/chat/completions",{method:"POST"},res=>res.pipe(process.stdout));r.on("error",()=>process.exit(1));r.end(JSON.stringify({model:"test-model"}))'`;
  const result = await runBenchmark(root, { ...benchmark, runtime: 'node', network: true, model: true, command }, undefined,
    { baseUrl: `http://127.0.0.1:${port}/v1`, key: 'secret-test-key', model: 'test-model' });
  assert.equal(result.status, 'measured', JSON.stringify(result));
  if (result.status === 'measured') assert.equal(result.actual, 3);
  assert.ok(!JSON.stringify(result).includes('secret-test-key'));
});

test('online search proxy rejects local destinations', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-search-proxy-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = `python -c 'import json,urllib.request,urllib.error;\ntry: urllib.request.urlopen("http://127.0.0.1:9/", timeout=5)\nexcept urllib.error.HTTPError as e: print(json.dumps({"value":e.code}))'`;
  const result = await runBenchmark(root, { ...benchmark, network: true, command, expected: 403 }, undefined, undefined, false, undefined, undefined, true);
  assert.equal(result.status, 'measured', JSON.stringify(result));
  if (result.status === 'measured') assert.equal(result.matched, true);
});


test('fails closed when the DSH sandbox is unavailable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-unavailable-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(sandbox, 'confine', async () => { throw Object.assign(new Error('unavailable'), { code: 'SANDBOX_UNAVAILABLE' }); });
  const result = await runBenchmark(root, { ...benchmark, runtime: 'node', command: `echo '{"value":3}'` });
  assert.equal(result.status, 'unavailable');
});
