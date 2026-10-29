import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findPi, parseBenchmark, runBenchmark } from './benchmark.js';

const benchmark = { runtime: 'python' as const, network: false, command: '', metric: 'example', unit: 'count', comparison: 'eq' as const, expected: 3, basis: 'fixture' };
const dockerAvailable = spawnSync('docker', ['image', 'inspect', 'python:3.12-alpine'], { stdio: 'ignore', timeout: 5000 }).status === 0;
const piAvailable = !!await findPi();

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

test('provides Pi in the isolated container without model credentials', { skip: !dockerAvailable || !piAvailable, timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-pi-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await runBenchmark(root, { ...benchmark, runtime: 'node', network: true, agent: true, expected: 1,
    command: `pi --version >&2 && node -e 'if(process.env.REPROCHECK_MODEL_API_KEY)process.exit(1); console.log(JSON.stringify({value:1}))'` });
  assert.equal(result.status, 'measured', JSON.stringify(result));
  if (result.status === 'measured') assert.equal(result.agent?.name, 'pi');
});

test('runs a real offline measurement with an isolated writable copy', { skip: !dockerAvailable, timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-benchmark-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'data.txt'), 'abc');
  const command = `python -c 'import json, pathlib, socket; p=pathlib.Path("data.txt"); n=len(p.read_text()); p.write_text("changed"); s=socket.socket(); s.settimeout(1); assert s.connect_ex(("1.1.1.1", 80)) != 0; print(json.dumps({"value": n}))'`;
  const result = await runBenchmark(root, { ...benchmark, command });
  assert.equal(result.status, 'measured');
  if (result.status === 'measured') {
    assert.equal(result.actual, 3);
    assert.equal(result.matched, true);
  }
  const exploratory = await runBenchmark(root, { ...benchmark, command, comparison: null, expected: null });
  assert.equal(exploratory.status, 'measured');
  if (exploratory.status === 'measured') {
    assert.equal(exploratory.actual, 3);
    assert.equal(exploratory.matched, null);
  }
  assert.equal(await readFile(join(root, 'data.txt'), 'utf8'), 'abc');
  const longCommand = `#${'x'.repeat(16000 - command.length - 2)}\n${command}`;
  const longResult = await runBenchmark(root, parseBenchmark({ ...benchmark, command: longCommand })!);
  assert.equal(longResult.status, 'measured', JSON.stringify(longResult));
  const invalid = await runBenchmark(root, { ...benchmark, command: 'echo not-json' });
  assert.equal(invalid.status, 'invalid_output');
  const failed = await runBenchmark(root, { ...benchmark, command: 'exit 7' });
  assert.equal(failed.status, 'failed');
  if (failed.status === 'failed' && 'exitCode' in failed) assert.equal(failed.exitCode, 7);
  const malformed = await runBenchmark(root, { ...benchmark, command: 'if true; then' });
  assert.equal(malformed.status, 'failed');
  if (malformed.status === 'failed' && 'stderr' in malformed) assert.match(malformed.stderr, /syntax error/i);
  const installFailed = await runBenchmark(root, { ...benchmark, command: 'python -m pip install --no-index definitely-not-a-real-package-reprocheck >&2' });
  assert.equal(installFailed.status, 'failed');
  if (installFailed.status === 'failed' && 'stderr' in installFailed) assert.match(installFailed.stderr, /definitely-not-a-real-package-reprocheck/);
  const before = spawnSync('docker', ['ps', '-a', '--filter', 'name=reprocheck-', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.trim().split('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancelled')), 1000);
  try {
    await assert.rejects(runBenchmark(root, { ...benchmark, command: 'sleep 30' }, controller.signal), /cancelled/);
  } finally {
    clearTimeout(timer);
  }
  const containers = spawnSync('docker', ['ps', '-a', '--filter', 'name=reprocheck-', '--format', '{{.Names}}'], { encoding: 'utf8' });
  assert.ok(containers.stdout.trim().split('\n').every((name) => !name || before.includes(name)));
});

test('copies a repository larger than the old limit and allows dependency-sized file counts', { skip: !dockerAvailable, timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-large-repo-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'large-file');
  await writeFile(file, '');
  await truncate(file, 160 * 1024 * 1024);
  const command = `python -c 'import json, pathlib; p=pathlib.Path("large-file"); d=pathlib.Path("deps"); d.mkdir(); [(d / str(i)).touch() for i in range(8500)]; print(json.dumps({"value":p.stat().st_size}))'`;
  const result = await runBenchmark(root, { ...benchmark, command, expected: 160 * 1024 * 1024 });
  assert.equal(result.status, 'measured', JSON.stringify(result));
  if (result.status === 'measured') assert.equal(result.matched, true);
});

test('installs Python and Node dependencies through the public-only proxy',
  { skip: !dockerAvailable || process.env.REPROCHECK_ONLINE_TEST !== '1', timeout: 300000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-online-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = spawnSync('docker', ['ps', '-a', '--filter', 'name=reprocheck-', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout.trim().split('\n');
  const networksBefore = spawnSync('docker', ['network', 'ls', '--filter', 'name=reprocheck-', '--format', '{{.Name}}'], { encoding: 'utf8' }).stdout.trim().split('\n');
  const python = `python -c 'import http.client, socket; c=http.client.HTTPConnection("egress",3128,timeout=5); c.request("GET","http://169.254.169.254/"); assert c.getresponse().status==403; s=socket.socket(); s.settimeout(2); assert s.connect_ex(("1.1.1.1",80)) != 0; assert socket.getaddrinfo("egress",3128)' && if python -c 'import socket; socket.getaddrinfo("pypi.org",80)' 2>/dev/null; then exit 9; fi && python -m pip install --disable-pip-version-check --no-cache-dir --target /work/deps idna==3.10 >&2 && python -c 'import json,sys; sys.path.insert(0,"/work/deps"); import idna; print(json.dumps({"value":len(idna.__version__)}))'`;
  const pythonResult = await runBenchmark(root, { ...benchmark, network: true, expected: 4, command: python });
  assert.equal(pythonResult.status, 'measured', JSON.stringify(pythonResult));
  if (pythonResult.status === 'measured') assert.equal(pythonResult.matched, true);
  const nodeResult = await runBenchmark(root, { ...benchmark, runtime: 'node', network: true, expected: 1,
    command: `npm install --prefix /work --no-audit --no-fund --ignore-scripts is-number@7.0.0 >&2 && node -e 'console.log(JSON.stringify({value:require("/work/node_modules/is-number")("3")?1:0}))'` });
  assert.equal(nodeResult.status, 'measured', JSON.stringify(nodeResult));
  if (nodeResult.status === 'measured') assert.equal(nodeResult.matched, true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancelled online')), 2500);
  try {
    await assert.rejects(runBenchmark(root, { ...benchmark, network: true, command: 'sleep 30' }, controller.signal), /cancelled online/);
  } finally { clearTimeout(timer); }
  const containers = spawnSync('docker', ['ps', '-a', '--filter', 'name=reprocheck-', '--format', '{{.Names}}'], { encoding: 'utf8' });
  assert.ok(containers.stdout.trim().split('\n').every((name) => !name || before.includes(name)));
  const networks = spawnSync('docker', ['network', 'ls', '--filter', 'name=reprocheck-', '--format', '{{.Name}}'], { encoding: 'utf8' });
  assert.ok(networks.stdout.trim().split('\n').every((name) => !name || networksBefore.includes(name)));
});
