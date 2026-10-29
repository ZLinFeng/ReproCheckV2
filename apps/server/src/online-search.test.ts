import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { searchOnline } from './online-search.js';

test('retrieves actual public search results and source text',
  { skip: process.env.REPROCHECK_ONLINE_TEST !== '1', timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-search-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const largeFile = join(root, 'large-file');
  await writeFile(largeFile, '');
  await truncate(largeFile, 1100 * 1024 * 1024);
  const evidence = await searchOnline(root, [{ claimId: 'c1', query: 'SWE-bench benchmark' }]);
  assert.ok(evidence.searches.some((item) => item.results.some((result) => result.url.includes('github.com/SWE-bench/'))), JSON.stringify(evidence.errors));
  assert.ok(evidence.sources.some((item) => item.url.includes('SWE-bench/SWE-bench') && item.content.length > 100));
});
