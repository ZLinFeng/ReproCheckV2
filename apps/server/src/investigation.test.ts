import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { app } from './app.js';
import { findDocuments, investigate, InvestigationTimeoutError, parseProject, resultsDir } from './investigation.js';

const project = { type: 'other', installation: 'simple', missingRequirements: [], reason: 'Python project with ordinary installation' };
const experiment = { installation: 'none', installationReason: 'No installation required', missingRequirements: [], network: false, blockedReason: null };

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

test('rejects ineligible or unclear project requirements', () => {
  assert.equal(parseProject(project).eligible, true);
  assert.equal(parseProject({ ...project, installation: 'complex' }).eligible, false);
  assert.equal(parseProject({ ...project, type: 'unknown' }).eligible, false);
  assert.equal(parseProject({ ...project, type: 'mcp', installation: 'complex' }).eligible, true);
  assert.equal(parseProject({ ...project, type: 'cli', missingRequirements: ['GPU'] }).eligible, false);
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
    return { harness: { run: async (prompt: string) => { prompts.push(prompt); return { finalResponse: JSON.stringify(answers.shift()) }; } },
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
        benchmark: { runtime: 'python', network: false, command: `python -c 'import json; print(json.dumps({"value": len(open("README.md").read())}))'`,
          metric: 'characters', unit: 'count', comparison: 'eq', expected: 20, basis: 'test fixture' } }] },
      { summary: 'Fixture only', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'Not a performance measurement', nextStep: 'Run a real benchmark.' }] },
    );
    const measured = await investigate(app, 'https://github.com/owner/repo', measuredId, new AbortController().signal, () => {});
    assert.equal(measured.benchmark.runs[0].status, 'measured');
    assert.equal(measured.benchmark.runs[0].matched, true);
    assert.equal(JSON.parse(await readFile(join(resultsDir, measuredId, 'benchmark.json'), 'utf8')).runs[0].actual, 20);
    assert.equal(measured.findings[0].status, 'inconclusive');

    const retryId = randomUUID();
    t.after(() => rm(join(resultsDir, retryId), { recursive: true, force: true }));
    answers.push(
      { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
      { assessment: 'Fixture', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Fixture measurement',
        benchmark: { runtime: 'python', network: false, command: `python -c 'open("repositoryREADME.md")'`,
          metric: 'characters', unit: 'count', comparison: 'eq', expected: 20, basis: 'test fixture' } }] },
      { benchmark: { command: `python -c 'import json; print(json.dumps({"value": len(open("README.md").read())}))'` } },
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
        benchmark: { runtime: 'python', network: false, command: `python -c 'open("repositoryREADME.md")'`,
          metric: 'characters', unit: 'count', comparison: 'eq', expected: 20, basis: 'test fixture' } }] },
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
          benchmark: { runtime: 'python', network: false, command: `printf '%s\\n' 'REPROCHECK_PROGRESS {"task":"case-1","status":"completed","arms":{"baseline":1,"skill":2}}' >&2; sleep 30`,
            metric: 'characters', unit: 'count', comparison: null, expected: null, basis: 'test fixture' } },
        { ...experiment, needsTaskData: false, claimId: 'c2', path: 'README.md', method: 'Read', reproduction: 'No experiment' },
      ] },
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
        benchmark: { runtime: 'python', network: false, command: 'echo impossible', metric: 'time', unit: 's', comparison: 'lt', expected: 1, basis: 'fixture' } }] },
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
    { assessment: 'Missing API key', project, experiments: [{ ...experiment, missingRequirements: ['API key'], claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Measure',
      benchmark: { runtime: 'python', network: false, command: 'echo impossible', metric: 'time', unit: 's', comparison: 'lt', expected: 1, basis: 'fixture' } }] },
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
      benchmark: { runtime: 'python', network: true, agent: true, model: true, command: 'pi', metric: 'time', unit: 's', comparison: 'lt', expected: 1, basis: 'fixture' } }] },
    { summary: 'Unavailable', findings: [{ claimId: 'c1', status: 'inconclusive', explanation: 'Pi requires Node', nextStep: 'Use a compatible environment.' }] },
  );
  const invalidPlan = await investigate(app, 'https://github.com/owner/repo', invalidPlanId, new AbortController().signal, () => {});
  assert.equal(invalidPlan.benchmark.runs[0].status, 'not_runnable');
  assert.match(invalidPlan.benchmark.runs[0].reason!, /Node/);

  const onlineId = randomUUID();
  t.after(() => rm(join(resultsDir, onlineId), { recursive: true, force: true }));
  onlineResponse = { searches: [{ claimId: 'c1', query: 'performance benchmark tasks', results: [{ url: 'https://example.org/tasks', title: 'Tasks' }] }],
    sources: [{ claimId: 'c1', url: 'https://example.org/tasks', title: 'Tasks', content: 'Public benchmark task descriptions.', truncated: false }], errors: [] };
  answers.push(
    { summary: 'One claim', claims: [{ id: 'c1', claim: '30% less time', sourcePath: 'README.md', quote: 'Uses 30% less time.' }] },
    { assessment: 'Need tasks', project, experiments: [{ ...experiment, claimId: 'c1', path: 'README.md', method: 'Read', reproduction: 'Synthetic fallback', needsTaskData: true, searchQuery: 'owner repo performance benchmark tasks',
      benchmark: { runtime: 'python', network: false, command: 'echo fixture', metric: 'time', unit: 's', comparison: null, expected: null, basis: 'Exploratory task without a threshold' } }] },
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
});
