import assert from 'node:assert/strict';
import test from 'node:test';
import { metricSummary } from './metric-summary.js';

test('joins conclusions with measurements and valid reported sample counts', () => {
  const report = {
    metrics: { claims: [{ id: 'a', claim: 'A claim' }, { id: 'b', claim: 'Another claim' }] },
    findings: [{ claimId: 'a', status: 'inconclusive' }, { claimId: 'b', status: 'evidence_only' }],
    benchmark: { runs: [
      { claimId: 'a', status: 'measured', actual: 0, stdout: '{"requested":3,"completed":2}' },
      { claimId: 'b', status: 'not_runnable', reason: 'Missing data' },
    ] },
  };
  const rows = metricSummary(report);
  assert.equal(rows[0].claim.claim, 'A claim');
  assert.equal(rows[0].run.actual, 0);
  assert.equal(rows[0].sample, '2 / 3 samples completed (reported by experiment)');
  assert.equal(rows[1].run.reason, 'Missing data');
  assert.equal(rows[1].sample, '');
  report.benchmark.runs[0].stdout = '{"requested":2,"completed":3}';
  assert.equal(metricSummary(report)[0].sample, '');
  assert.deepEqual(metricSummary({}), []);
});
