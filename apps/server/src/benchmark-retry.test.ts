import assert from 'node:assert/strict';
import test from 'node:test';
import { extractRepairCommand, runWithRetry, withRepairDeadline } from './benchmark-retry.js';
import type { Benchmark } from './benchmark.js';

const plan: Benchmark = { runtime: 'python', network: false, command: 'bad', metric: 'time', unit: 's', comparison: null, expected: null, basis: 'fixture' };

test('accepts unambiguous repair formats and rejects conflicting commands', () => {
  assert.equal(extractRepairCommand({ command: 'fixed' }), 'fixed');
  assert.equal(extractRepairCommand({ benchmark: { command: 'fixed' } }), 'fixed');
  assert.equal(extractRepairCommand({ experiment: { command: 'fixed' } }), 'fixed');
  assert.equal(extractRepairCommand({ experiment: { benchmark: { command: 'fixed' } } }), 'fixed');
  assert.equal(extractRepairCommand({ command: null }), null);
  assert.throws(() => extractRepairCommand({ command: 'one', benchmark: { command: 'two' } }), /conflicting/);
});

test('closes an independent repair session when its deadline expires', async () => {
  let closed = false;
  await assert.rejects(withRepairDeadline(() => new Promise(() => {}), async () => { closed = true; }, new AbortController().signal, 20), /timed out/);
  assert.equal(closed, true);
});

test('retains both attempts and only replaces the command', async () => {
  const seen: Benchmark[] = [];
  const progress: string[] = [];
  const result = await runWithRetry(plan, async (benchmark) => {
    seen.push(benchmark);
    return seen.length === 1 ? { status: 'failed', error: 'missing file' } : { status: 'measured', actual: 2, matched: null };
  }, async (_benchmark, failed) => {
    assert.equal(failed.status, 'failed');
    return 'fixed';
  }, undefined, async (attempts, retrying) => { progress.push(`${attempts.length}:${retrying}`); });
  assert.equal(result.status, 'measured');
  assert.deepEqual(seen[1], { ...plan, command: 'fixed' });
  assert.deepEqual(result.attempts.map((attempt) => attempt.result.status), ['failed', 'measured']);
  assert.deepEqual(progress, ['1:true', '2:false']);
});

test('does not retry unavailable environments and retains the original failure when repair is invalid', async () => {
  let repairs = 0;
  const unavailable = await runWithRetry(plan, async () => ({ status: 'unavailable', error: 'no sandbox' }), async () => { repairs++; return 'fixed'; });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(repairs, 0);
  const failed = await runWithRetry(plan, async () => ({ status: 'invalid_output', stdout: 'wrong', stderr: '', environment: { platform: 'darwin', release: '', architecture: '', tools: {}, sandbox: { provider: 'dsh-local', mode: 'workspace-write', enforcement: 'full' as const }, network: 'host-unrestricted', networkRequested: false }, elapsedMs: 1, exitCode: 0, timedOut: false }), async () => null);
  assert.equal(failed.status, 'invalid_output');
  assert.match(failed.retryError!, /No modified executable command/);
  assert.equal(failed.attempts.length, 1);
});

test('propagates cancellation during repair', async () => {
  const controller = new AbortController();
  await assert.rejects(runWithRetry(plan, async () => ({ status: 'failed', error: 'failed' }), async () => {
    controller.abort(new Error('cancelled'));
    return 'fixed';
  }, controller.signal), /cancelled/);
});

test('does not retry a second failure', async () => {
  let calls = 0;
  const result = await runWithRetry(plan, async () => { calls++; return { status: 'failed', error: `failure ${calls}` }; }, async () => 'fixed');
  assert.equal(calls, 2);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.attempts.map((attempt) => attempt.result.status), ['failed', 'failed']);
});
