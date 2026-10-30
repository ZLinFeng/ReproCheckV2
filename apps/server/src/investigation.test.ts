import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { app } from './app.js';
import { findDocuments, investigate, InvestigationTimeoutError, parseProject, resultsDir, verifiedQuote, alignNetworkRequirement } from './investigation.js';

const project = { type: 'other', installation: 'simple', missingRequirements: [], reason: 'Python project with ordinary installation' };
const experiment = { installation: 'none', installationReason: 'No installation required', missingRequirements: [], network: false, blockedReason: null };
// The plan skill also mentions a self-contained POSIX command, so match the command request's own instruction.
const commandPrompts = (prompts: string[]) => prompts.filter((prompt) => prompt.includes('Return only the experiment as one self-contained POSIX'));

test('aligns the network flag of agent and model experiments instead of discarding them', () => {
  const plan = { experiments: [
    { claimId: 'c1', network: false, benchmark: { runtime: 'node', network: false, agent: true, model: true, metric: 'lines', unit: 'lines', command: 'x', comparison: null, expected: null, basis: 'b' } },
    { claimId: 'c2', network: false, benchmark: { runtime: 'python', network: false, metric: 's', unit: 's', command: 'x', comparison: null, expected: null, basis: 'b' } },
  ] };
  const aligned = alignNetworkRequirement(plan) as typeof plan;
  assert.equal(aligned.experiments[0].network, true);
  assert.equal(aligned.experiments[0].benchmark.network, true);
  assert.equal(aligned.experiments[1].network, false);
  assert.equal(aligned.experiments[1].benchmark.network, false);
});

test('includes benchmark task definitions, keeping the beginning and end of long files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-docs-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'benchmarks/agentic'), { recursive: true });
  await writeFile(join(root, 'README.md'), 'Project');
  await writeFile(join(root, 'benchmarks/agentic/README.md'), 'Task instructions');
  await writeFile(join(root, 'benchmarks/agentic/tasks.py'), `HEAD${'x'.repeat(40000)}TASKS = {'sample': 1}`);
  const docs = await findDocuments(root);
  assert.ok(docs.some((item) => item.path === 'benchmarks/agentic/README.md'));
  const tasks = docs.find((item) => item.path === 'benchmarks/agentic/tasks.py');
  assert.ok(tasks?.content.startsWith('HEAD'));
  assert.ok(tasks?.content.includes("TASKS = {'sample': 1}"));
  assert.match(tasks!.content, /file excerpt omitted/);
});

test('preserves exact source quotes when inline HTML interrupts a displayed quote', () => {
  const source = '<strong>And yet: 98% of risky logic ships with a test.</strong> Without Ponytail: 68%.';
  assert.equal(verifiedQuote(source, 'And yet: 98% of risky logic ships with a test. Without Ponytail: 68%.'),
    'And yet: 98% of risky logic ships with a test.</strong> Without Ponytail: 68%.');
  assert.equal(verifiedQuote(source, '98% of risky logic'), '98% of risky logic');
  assert.equal(verifiedQuote(source, '99% of risky logic'), undefined);
  assert.equal(verifiedQuote('A<div>not inline</div>B', 'Anot inlineB'), undefined);
});

test('rejects ineligible or unclear project requirements', () => {
  assert.equal(parseProject(project).eligible, true);
  assert.equal(parseProject({ ...project, installation: 'complex' }).eligible, false);
  assert.equal(parseProject({ ...project, type: 'unknown' }).eligible, false);
  assert.equal(parseProject({ ...project, type: 'mcp', installation: 'complex' }).eligible, true);
  assert.equal(parseProject({ ...project, type: 'cli', missingRequirements: ['GPU'] }).eligible, true);
  assert.deepEqual(parseProject({ ...project, missingRequirements: ['GPU'] }).missingRequirements, ['GPU']);
  assert.throws(() => parseProject({ ...project, missingRequirements: 'GPU' }));
});

test('persists claims, an evidence plan, sandbox observations and a cautious report', { skip: process.platform !== 'darwin' }, async (t) => {
  await app.ready();
  t.after(() => app.close());
  const fakeBin = await mkdtemp(join(tmpdir(), 'reprocheck-fake-git-'));
  const git = join(fakeBin, 'git');
  await writeFile(git, `#!/bin/sh\ncase "$*" in\n  *clone*) for last; do :; done; /bin/mkdir -p "$last"; printf 'Uses 30%% less time.\\n' > "$last/README.md";;\n  *rev-parse*) printf '0123456789012345678901234567890123456789\\n';;\nesac\n`);
  await chmod(git, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath || "/usr/local/bin:/usr/bin:/bin"}`;
  const id = randomUUID();
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(fakeBin, { recursive: true, force: true });
    await rm(join(resultsDir, id), { recursive: true, force: true });
  });
  const answers = [
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Author report only', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read the claim', reproduction: 'Run paired benchmarks.' }] },
    { summary: 'Not independently reproduced', findings: [{ claimId: 'c1', status: 'evidence_only', explanation: 'Author statement', nextStep: 'Run paired benchmarks.' }] },
  ];
  let closed = false;
  let onlineResponse: Awaited<ReturnType<typeof app.searchOnline>> = { searches: [], sources: [], errors: [] };
  const searched: { claimId: string; query: string }[][] = [];
  const prompts: string[] = [];
  t.mock.method(app, 'searchOnline', async (_root, queries) => { searched.push(queries); return onlineResponse; });
  t.mock.method(app, 'createWebHarness', async (options) => {
    assert.deepEqual(options, { analysisOnly: true });
    return { harness: { run: async (prompt: string) => { prompts.push(prompt); const next = answers.shift();
      return { finalResponse: typeof next === 'string' ? next : JSON.stringify(next) ?? '' }; } },
      close: async () => { closed = true; } } as unknown as Awaited<ReturnType<typeof app.createWebHarness>>;
  });
  const stages: string[] = [];
  const details: { stage: string; data: object }[] = [];
  const result = await investigate(app, 'https://github.com/owner/repo', id, new AbortController().signal,
    (stage) => stages.push(stage), (stage, data) => details.push({ stage, data }));
  assert.deepEqual(stages, ['source', 'metrics', 'plan', 'online', 'sandbox', 'benchmark', 'assessment']);
  assert.equal(searched[0][0].claimId, 'c1');
  assert.equal(result.metrics.claims[0].sourceMatched, true);
  assert.equal(result.sandbox.observations[0].content, 'Uses 30% less time.\n');
  assert.equal(result.findings[0].status, 'evidence_only');
  assert.equal(result.benchmark.runs[0].status, 'not_runnable');
  assert.ok(details.some((item) => item.stage === 'metrics' && 'claims' in item.data));
  assert.ok(details.some((item) => item.stage === 'benchmark' && 'status' in item.data && item.data.status === 'not_runnable'));
  assert.ok(details.some((item) => item.stage === 'assessment' && 'findings' in item.data));
  assert.match(result.limitation, /does not establish independent reproduction/);
  assert.equal(JSON.parse(await readFile(join(resultsDir, id, 'status.json'), 'utf8')).status, 'complete');
  assert.equal(JSON.parse(await readFile(join(resultsDir, id, 'report.json'), 'utf8')).id, id);
  assert.equal(closed, true);

  if (spawnSync('python', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0) {
    const measuredId = randomUUID();
    t.after(() => rm(join(resultsDir, measuredId), { recursive: true, force: true }));
    answers.push(
      { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
      { assessment: 'Fixture', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Fixture measurement',
        missingRequirements: ['a README fixture', 'network access to fetch it'],
        benchmark: { runtime: 'python', network: false,
          metric: 'characters', unit: 'count', comparison: 'eq', expected: 20, basis: 'test fixture' } }] },
      `python -c 'import json; print(json.dumps({"value": len(open("README.md").read())}))'`,
      { summary: 'Fixture only', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'Not a performance measurement', nextStep: 'Run a real benchmark.' }] },
    );
    const measured = await investigate(app, 'https://github.com/owner/repo', measuredId, new AbortController().signal, () => {});
    assert.equal(measured.benchmark.runs[0].status, 'measured');
    assert.equal(measured.benchmark.runs[0].matched, true);
    assert.equal(JSON.parse(await readFile(join(resultsDir, measuredId, 'benchmark.json'), 'utf8')).runs[0].actual, 20);
    assert.match(await readFile(join(resultsDir, measuredId, 'model-command-c1.txt'), 'utf8'), /README\.md/);
    assert.equal(measured.findings[0].status, 'inconclusive');

    const syntaxId = randomUUID();
    t.after(() => rm(join(resultsDir, syntaxId), { recursive: true, force: true }));
    answers.push(
      { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
      { assessment: 'Fixture', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Fixture measurement',
        benchmark: { runtime: 'python', network: false, metric: 'characters', unit: 'count', comparison: 'eq', expected: 20, basis: 'test fixture' } }] },
      `printf bad > '${join(fakeBin, 'should-not-run')}'; if true; then`,
      `python -c 'import json; print(json.dumps({"value": len(open("README.md").read())}))'`,
      { summary: 'Fixture only', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'Fixture measurement', nextStep: 'Run a real benchmark.' }] },
    );
    const syntax = await investigate(app, 'https://github.com/owner/repo', syntaxId, new AbortController().signal, () => {});
    assert.equal(syntax.benchmark.runs[0].status, 'measured');
    if ('attempts' in syntax.benchmark.runs[0]) assert.equal(syntax.benchmark.runs[0].attempts.length, 1);
    assert.match(await readFile(join(resultsDir, syntaxId, 'model-command-c1.txt'), 'utf8'), /should-not-run/);
    assert.match(await readFile(join(resultsDir, syntaxId, 'model-command-c1-syntax-retry.txt'), 'utf8'), /README\.md/);
    await assert.rejects(readFile(join(fakeBin, 'should-not-run')), { code: 'ENOENT' });
    assert.ok(prompts.some((prompt) => prompt.includes('previous command failed the shell syntax check')));

    if (await access('/bin/dash', constants.X_OK).then(() => true, () => false)) {
      const portableId = randomUUID();
      t.after(() => rm(join(resultsDir, portableId), { recursive: true, force: true }));
      answers.push(
        { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
        { assessment: 'Fixture', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Fixture measurement',
          benchmark: { runtime: 'python', network: false, metric: 'characters', unit: 'count', comparison: null, expected: null, basis: 'test fixture' } }] },
        `baseline_times=()`,
        `python -c 'import json; print(json.dumps({"value": len(open("README.md").read())}))'`,
        { summary: 'Fixture only', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'Fixture measurement', nextStep: 'Run a real benchmark.' }] },
      );
      const portable = await investigate(app, 'https://github.com/owner/repo', portableId, new AbortController().signal, () => {});
      assert.equal(portable.benchmark.runs[0].status, 'measured');
      assert.match(await readFile(join(resultsDir, portableId, 'model-command-c1-syntax-retry.txt'), 'utf8'), /README\.md/);
    }

    const invalidCommandId = randomUUID();
    t.after(() => rm(join(resultsDir, invalidCommandId), { recursive: true, force: true }));
    answers.push(
      { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
      { assessment: 'Fixture', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Fixture measurement',
        benchmark: { runtime: 'python', network: false, metric: 'characters', unit: 'count', comparison: null, expected: null, basis: 'test fixture' } }] },
      `if true; then`, `while true; do`,
      { summary: 'Not runnable', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'Invalid command', nextStep: 'Correct the command.' }] },
    );
    const invalidCommand = await investigate(app, 'https://github.com/owner/repo', invalidCommandId, new AbortController().signal, () => {});
    assert.equal(invalidCommand.benchmark.runs[0].status, 'not_runnable');
    assert.match(invalidCommand.benchmark.runs[0].reason!, /invalid shell command/);

    const retryId = randomUUID();
    t.after(() => rm(join(resultsDir, retryId), { recursive: true, force: true }));
    answers.push(
      { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
      { assessment: 'Fixture', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Fixture measurement',
        benchmark: { runtime: 'python', network: false,
          metric: 'characters', unit: 'count', comparison: 'eq', expected: 20, basis: 'test fixture' } }] },
      `python -c 'open("repositoryREADME.md")'`,
      `python -c 'import json; print(json.dumps({"value": len(open("README.md").read())}))'`,
      { summary: 'Fixture only', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'A repaired fixture', nextStep: 'Run a real benchmark.' }] },
    );
    const retryDetails: { stage: string; data: object }[] = [];
    const retry = await investigate(app, 'https://github.com/owner/repo', retryId, new AbortController().signal, () => {},
      (stage, data) => retryDetails.push({ stage, data }));
    const retryRun = retry.benchmark.runs[0];
    assert.equal(retryRun.status, 'measured');
    assert.ok('attempts' in retryRun);
    if ('attempts' in retryRun) assert.deepEqual(retryRun.attempts.map((attempt) => attempt.result.status), ['failed', 'measured']);
    assert.ok(retryDetails.some((item) => item.stage === 'benchmark' && 'status' in item.data && item.data.status === 'retrying'));
    const saved = JSON.parse(await readFile(join(resultsDir, retryId, 'benchmark.json'), 'utf8'));
    assert.match(saved.runs[0].attempts[0].result.stderr, /repositoryREADME/);
    assert.equal(saved.runs[0].attempts[1].result.actual, 20);

    const timeoutId = randomUUID();
    t.after(() => rm(join(resultsDir, timeoutId), { recursive: true, force: true }));
    const timeout = new AbortController();
    answers.push(
      { summary: 'Two claims', claims: [
        { id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' },
        { id: 'c2', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
      { assessment: 'Fixture', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Fixture measurement',
        benchmark: { runtime: 'python', network: false,
          metric: 'characters', unit: 'count', comparison: 'eq', expected: 20, basis: 'test fixture' } }] },
      `python -c 'open("repositoryREADME.md")'`,
    );
    const partial = await investigate(app, 'https://github.com/owner/repo', timeoutId, timeout.signal, () => {}, (stage, data) => {
      if (stage === 'benchmark' && 'status' in data && data.status === 'retrying') timeout.abort(new InvestigationTimeoutError());
    });
    assert.equal(partial.partial, true);
    assert.deepEqual(partial.benchmark.runs.map((run) => run.status), ['interrupted', 'not_executed']);
    assert.ok('attempts' in partial.benchmark.runs[0]);
    assert.deepEqual(partial.findings.map((finding) => finding.status), ['inconclusive', 'inconclusive']);
    assert.equal(JSON.parse(await readFile(join(resultsDir, timeoutId, 'status.json'), 'utf8')).status, 'timed_out');
    assert.equal(JSON.parse(await readFile(join(resultsDir, timeoutId, 'report.json'), 'utf8')).partial, true);

    const runningTimeoutId = randomUUID();
    t.after(() => rm(join(resultsDir, runningTimeoutId), { recursive: true, force: true }));
    const runningTimeout = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let sampleReported = () => {};
    const sampleReady = new Promise<void>((resolve) => { sampleReported = resolve; });
    t.after(() => clearTimeout(deadline));
    answers.push(
      { summary: 'Two claims', claims: [
        { id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' },
        { id: 'c2', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
      { assessment: 'Fixture', project, experiments: [
        { ...experiment, needsTaskData: false, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Fixture measurement',
          benchmark: { runtime: 'python', network: false,
            metric: 'characters', unit: 'count', comparison: null, expected: null, basis: 'test fixture' } },
        { ...experiment, needsTaskData: false, claimId: 'c2', path: 'README.md', method: 'Read', reproduction: 'No experiment' },
      ] },
      `printf '%s\\n' 'REPROCHECK_PROGRESS {"task":"case-1","status":"completed","arms":{"baseline":1,"skill":2}}' >&2; sleep 30`,
    );
    const running = investigate(app, 'https://github.com/owner/repo', runningTimeoutId, runningTimeout.signal, (stage) => {
      if (stage === 'benchmark') deadline = setTimeout(() => runningTimeout.abort(new InvestigationTimeoutError()), 2000);
    }, (stage, data) => {
      if (stage === 'benchmark' && 'progressCount' in data) sampleReported();
    });
    await sampleReady;
    let savedDuringRun: any;
    for (let i = 0; i < 100; i++) {
      try {
        savedDuringRun = JSON.parse(await readFile(join(resultsDir, runningTimeoutId, 'benchmark.json'), 'utf8'));
        if (savedDuringRun.runs[0]?.progress?.length) break;
      } catch { /* asynchronous progress save has not completed yet */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(savedDuringRun.runs[0].status, 'running');
    assert.deepEqual(savedDuringRun.runs[0].progress[0], { task: 'case-1', status: 'completed', arms: { baseline: 1, skill: 2 }, attempt: 1, unverified: true });
    const runningPartial = await running;
    assert.equal(runningPartial.partial, true);
    assert.deepEqual(runningPartial.benchmark.runs.map((run) => run.status), ['interrupted', 'not_executed']);
    const interrupted = JSON.parse(await readFile(join(resultsDir, runningTimeoutId, 'benchmark.json'), 'utf8'));
    assert.match(interrupted.runs[0].attempts[0].result.stderr, /REPROCHECK_PROGRESS/);
    assert.equal(interrupted.runs[0].progress[0].task, 'case-1');
  }

  const unmatchedId = randomUUID();
  t.after(() => rm(join(resultsDir, unmatchedId), { recursive: true, force: true }));
  answers.push(
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'A quote not in the source' }] },
    { assessment: 'Author report only', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Repeat benchmark.' }] },
    { summary: 'Not reproduced', findings: [{ claimId: 'c1', status: 'evidence_only', explanation: 'Claimed evidence', nextStep: 'Repeat benchmark.' }] },
  );
  const unmatched = await investigate(app, 'https://github.com/owner/repo', unmatchedId, new AbortController().signal, () => {});
  assert.equal(unmatched.metrics.claims[0].sourceMatched, false);
  assert.equal(unmatched.findings[0].status, 'inconclusive');

  const blockedId = randomUUID();
  t.after(() => rm(join(resultsDir, blockedId), { recursive: true, force: true }));
  answers.push(
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Missing GPU', project: { ...project, installation: 'complex', missingRequirements: ['GPU'], reason: 'GPU required' },
      experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Measure',
        benchmark: { runtime: 'python', network: false, metric: 'time', unit: 's', comparison: 'lt', expected: 1, basis: 'fixture' } }] },
    'echo impossible',
    { summary: 'Unavailable', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'GPU unavailable', nextStep: 'Use a GPU.' }] },
  );
  const blocked = await investigate(app, 'https://github.com/owner/repo', blockedId, new AbortController().signal, () => {});
  assert.equal(blocked.plan.project.eligible, false);
  assert.equal(blocked.plan.experiments[0].benchmark, null);
  assert.match(blocked.benchmark.runs[0].reason!, /GPU/);

  const credentialsId = randomUUID();
  t.after(() => rm(join(resultsDir, credentialsId), { recursive: true, force: true }));
  answers.push(
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Missing API key', project, experiments: [{ ...experiment, missingRequirements: ['API key'],
      blockedReason: 'A required API key cannot be obtained in this environment.', claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Measure',
      benchmark: { runtime: 'python', network: false, metric: 'time', unit: 's', comparison: 'lt', expected: 1, basis: 'fixture' } }] },
    { summary: 'Unavailable', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'API key unavailable', nextStep: 'Supply credentials.' }] },
  );
  const credentials = await investigate(app, 'https://github.com/owner/repo', credentialsId, new AbortController().signal, () => {});
  assert.equal(credentials.plan.project.eligible, true);
  assert.equal(credentials.plan.experiments[0].benchmark, null);
  assert.match(credentials.benchmark.runs[0].reason!, /API key/);

  const invalidPlanId = randomUUID();
  t.after(() => rm(join(resultsDir, invalidPlanId), { recursive: true, force: true }));
  answers.push(
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Incompatible runtime', project, experiments: [{ ...experiment, network: true, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Measure',
      benchmark: { runtime: 'python', network: true, agent: true, model: true, metric: 'time', unit: 's', comparison: 'lt', expected: 1, basis: 'fixture' } }] },
    { summary: 'Unavailable', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'Pi requires Node', nextStep: 'Use a compatible environment.' }] },
  );
  const commandsBefore = commandPrompts(prompts).length;
  const invalidPlan = await investigate(app, 'https://github.com/owner/repo', invalidPlanId, new AbortController().signal, () => {});
  assert.equal(invalidPlan.benchmark.runs[0].status, 'not_runnable');
  assert.match(invalidPlan.benchmark.runs[0].reason!, /Node/);
  // No command was requested for a plan that can never pass.
  assert.equal(commandPrompts(prompts).length, commandsBefore);

  const invalidDraftId = randomUUID();
  t.after(() => rm(join(resultsDir, invalidDraftId), { recursive: true, force: true }));
  answers.push(
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Missing unit', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Measure',
      benchmark: { runtime: 'python', network: false, metric: 'time', comparison: null, expected: null, basis: 'fixture' } }] },
    { summary: 'Unavailable', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'Incomplete plan', nextStep: 'Provide a unit.' }] },
  );
  const invalidDraft = await investigate(app, 'https://github.com/owner/repo', invalidDraftId, new AbortController().signal, () => {});
  assert.equal(invalidDraft.benchmark.runs[0].status, 'not_runnable');
  assert.match(invalidDraft.benchmark.runs[0].reason!, /unit must be a non-empty string/);
  assert.equal(commandPrompts(prompts).length, commandsBefore);

  const onlineId = randomUUID();
  t.after(() => rm(join(resultsDir, onlineId), { recursive: true, force: true }));
  onlineResponse = { searches: [{ claimId: 'c1', query: 'performance benchmark tasks', results: [{ url: 'https://example.org/tasks', title: 'Tasks' }] }],
    sources: [{ claimId: 'c1', url: 'https://example.org/tasks', title: 'Tasks', content: 'Public benchmark task descriptions.', truncated: false }], errors: [] };
  answers.push(
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Need tasks', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Synthetic fallback', needsTaskData: true, searchQuery: 'owner repo performance benchmark tasks',
      benchmark: { runtime: 'python', network: false, metric: 'time', unit: 's', comparison: null, expected: null, basis: 'Exploratory task without a threshold' } }] },
    { assessment: 'Found tasks', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Compare an external task',
      onlineSources: [{ url: 'https://example.org/tasks', quote: 'Public benchmark task descriptions.' }] }] },
    { summary: 'Not reproduced', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'External task differs', nextStep: 'Run a comparison.' }] },
  );
  const onlineStages: string[] = [];
  const onlineReport = await investigate(app, 'https://github.com/owner/repo', onlineId, new AbortController().signal, (stage) => onlineStages.push(stage));
  assert.ok(onlineStages.includes('online'));
  assert.equal(searched.at(-1)?.[0].query, 'performance benchmark tasks');
  assert.ok(prompts.some((prompt) => prompt.includes('简单 prompt 或任务') && prompt.includes('comparison 和 expected 均为 null')));
  assert.ok(prompts.every((prompt) => prompt.includes('Write all human-readable descriptions and explanations in English') && prompt.includes('Preserve exact source quotations')));
  assert.equal(onlineReport.plan.experiments[0].onlineSources[0].url, 'https://example.org/tasks');
  assert.equal(onlineReport.online.sources[0].content, 'Public benchmark task descriptions.');
  assert.equal(JSON.parse(await readFile(join(resultsDir, onlineId, 'online.json'), 'utf8')).sources.length, 1);

  const invalidSourceId = randomUUID();
  t.after(() => rm(join(resultsDir, invalidSourceId), { recursive: true, force: true }));
  answers.push(
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Need tasks', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Need data', needsTaskData: true }] },
    { assessment: 'Invented quote', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Unverified',
      onlineSources: [{ url: 'https://example.org/tasks', quote: 'not in source' }] }] },
    { assessment: 'Invented quote again', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Unverified',
      onlineSources: [{ url: 'https://example.org/tasks', quote: 'not in source' }] }] },
    { summary: 'Not reproduced', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'No verified task', nextStep: 'Check source.' }] },
  );
  const invalidSource = await investigate(app, 'https://github.com/owner/repo', invalidSourceId, new AbortController().signal, () => {});
  assert.equal(invalidSource.plan.assessment, 'Need tasks');
  assert.match(invalidSource.online.errors[0].error, /original plan was retained.*quote does not exactly match.*example.org/);
  onlineResponse = { searches: [], sources: [], errors: [] };

  const failedId = randomUUID();
  t.after(() => rm(join(resultsDir, failedId), { recursive: true, force: true }));
  await assert.rejects(() => investigate(app, 'https://github.com/owner/repo', failedId, new AbortController().signal, () => {}));
  const failed = JSON.parse(await readFile(join(resultsDir, failedId, 'status.json'), 'utf8'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stage, 'metrics');
  assert.equal(failed.diagnostic, 'The model returned an empty response.');
});

test('retries once when the model returns invalid JSON', async (t) => {
  await app.ready();
  t.after(() => app.close());
  const fakeBin = await mkdtemp(join(tmpdir(), 'reprocheck-fake-git-'));
  const git = join(fakeBin, 'git');
  await writeFile(git, `#!/bin/sh\ncase "$*" in\n  *clone*) for last; do :; done; /bin/mkdir -p "$last"; printf 'Uses 30%% less time.\\n' > "$last/README.md";;\n  *rev-parse*) printf '0123456789012345678901234567890123456789\\n';;\nesac\n`);
  await chmod(git, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath || '/usr/local/bin:/usr/bin:/bin'}`;
  const id = randomUUID();
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(fakeBin, { recursive: true, force: true });
    await rm(join(resultsDir, id), { recursive: true, force: true });
  });
  const answers: unknown[] = [
    '{"summary": "interrupted',
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Author report only', project, experiments: [] },
    { summary: 'Not reproduced', findings: [{ claimId: 'c1', status: 'evidence_only', explanation: 'Author statement', nextStep: 'Run paired benchmarks.' }] },
  ];
  const prompts: string[] = [];
  t.mock.method(app, 'searchOnline', async () => ({ searches: [], sources: [], errors: [] }));
  t.mock.method(app, 'createWebHarness', async () => ({
    harness: { run: async (prompt: string) => { prompts.push(prompt); const next = answers.shift();
      return { finalResponse: typeof next === 'string' ? next : JSON.stringify(next) ?? '' }; } },
    close: async () => {},
  } as unknown as Awaited<ReturnType<typeof app.createWebHarness>>));
  const report = await investigate(app, 'https://github.com/owner/repo', id, new AbortController().signal, () => {});
  assert.equal(report.metrics.claims[0].sourceMatched, true);
  assert.match(await readFile(join(resultsDir, id, 'model-metrics-retry.txt'), 'utf8'), /One claim/);
  // An unclosed reply was cut off by the output limit, so the retry asks for a shorter answer.
  assert.match(prompts[1], /probably cut off by the output limit/);
});

test('retries a plan that fails validation, such as a merged claim id', async (t) => {
  await app.ready();
  t.after(() => app.close());
  const fakeBin = await mkdtemp(join(tmpdir(), 'reprocheck-fake-git-'));
  const git = join(fakeBin, 'git');
  await writeFile(git, `#!/bin/sh\ncase "$*" in\n  *clone*) for last; do :; done; /bin/mkdir -p "$last"; printf 'Uses 30%% less time.\\n' > "$last/README.md";;\n  *rev-parse*) printf '0123456789012345678901234567890123456789\\n';;\nesac\n`);
  await chmod(git, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath || '/usr/local/bin:/usr/bin:/bin'}`;
  const id = randomUUID();
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(fakeBin, { recursive: true, force: true });
    await rm(join(resultsDir, id), { recursive: true, force: true });
  });
  const answers: unknown[] = [
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Merged claims', project, experiments: [{ ...experiment, claimId: 'c1,c7,c8', path: 'README.md', method: 'Read', reproduction: 'Measure' }] },
    { assessment: 'Separate claims', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Measure' }] },
    { summary: 'Not reproduced', findings: [{ claimId: 'c1', status: 'evidence_only', explanation: 'Author statement', nextStep: 'Run paired benchmarks.' }] },
  ];
  t.mock.method(app, 'searchOnline', async () => ({ searches: [], sources: [], errors: [] }));
  t.mock.method(app, 'createWebHarness', async () => ({
    harness: { run: async () => { const next = answers.shift();
      return { finalResponse: typeof next === 'string' ? next : JSON.stringify(next) ?? '' }; } },
    close: async () => {},
  } as unknown as Awaited<ReturnType<typeof app.createWebHarness>>));
  const report = await investigate(app, 'https://github.com/owner/repo', id, new AbortController().signal, () => {});
  assert.equal(report.plan.experiments[0].claimId, 'c1');
  assert.match(await readFile(join(resultsDir, id, 'model-plan.txt'), 'utf8'), /c1,c7,c8/);
  assert.match(await readFile(join(resultsDir, id, 'model-plan-2.txt'), 'utf8'), /"claimId":"c1"/);
});

test('retries a plan that blocks on a third-party CLI or API key', async (t) => {
  await app.ready();
  t.after(() => app.close());
  const fakeBin = await mkdtemp(join(tmpdir(), 'reprocheck-fake-git-'));
  const git = join(fakeBin, 'git');
  await writeFile(git, `#!/bin/sh\ncase "$*" in\n  *clone*) for last; do :; done; /bin/mkdir -p "$last"; printf 'Saves 20%% tokens with Claude.\\n' > "$last/README.md";;\n  *rev-parse*) printf '0123456789012345678901234567890123456789\\n';;\nesac\n`);
  await chmod(git, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${oldPath || '/usr/local/bin:/usr/bin:/bin'}`;
  const id = randomUUID();
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(fakeBin, { recursive: true, force: true });
    await rm(join(resultsDir, id), { recursive: true, force: true });
  });
  const benchmark = { runtime: 'python', network: true, model: true, metric: 'tokens', unit: 'count', comparison: null, expected: null, basis: 'fixture' };
  const answers: unknown[] = [
    { summary: 'One claim', claims: [{ id: 'c1', claim: '20% fewer tokens', sourcePath: 'README.md', quote: 'Saves 20% tokens with Claude.' }] },
    { assessment: 'Needs Anthropic', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Count tokens with the Anthropic tokenizer',
      blockedReason: 'Requires Anthropic API key to access Claude\'s tokenizer; not provided.' }] },
    { assessment: 'Substituted with Pi', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Count tokens with the Pi-configured model',
      benchmark }] },
    `python -c 'import json; print(json.dumps({"value": 20}))'`,
    { summary: 'Fixture only', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'Substituted model', nextStep: 'Check thresholds.' }] },
  ];
  const prompts: string[] = [];
  t.mock.method(app, 'searchOnline', async () => ({ searches: [], sources: [], errors: [] }));
  t.mock.method(app, 'createWebHarness', async () => ({
    harness: { run: async (prompt: string) => { prompts.push(prompt); const next = answers.shift();
      return { finalResponse: typeof next === 'string' ? next : JSON.stringify(next) ?? '' }; } },
    close: async () => {},
  } as unknown as Awaited<ReturnType<typeof app.createWebHarness>>));
  const report = await investigate(app, 'https://github.com/owner/repo', id, new AbortController().signal, () => {});
  assert.match(prompts.find((prompt) => prompt.includes('validationError')) ?? '', /缺少第三方 CLI/);
  assert.equal(report.plan.experiments[0].blockedReason, null);
  assert.equal(report.plan.experiments[0].benchmark?.network, true);
  assert.equal(report.benchmark.runs[0].status, 'measured');
});
