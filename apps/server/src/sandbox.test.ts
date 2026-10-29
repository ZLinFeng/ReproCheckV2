import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { githubRepository } from './investigation.js';
import { readEvidenceInSandbox } from './sandbox.js';

test('only accepts GitHub repository roots', () => {
  assert.equal(githubRepository('https://github.com/owner/repo.git'), 'https://github.com/owner/repo');
  for (const url of ['https://github.com/owner/repo/issues', 'https://github.com.evil/owner/repo',
    'https://github.com/owner/repo?x=1', 'http://github.com/owner/repo']) assert.throws(() => githubRepository(url));
});

test('sandbox reads repository evidence and rejects paths outside it', { skip: process.platform !== 'darwin' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprocheck-sandbox-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'evidence.txt'), 'sample evidence');
  await symlink('/etc/hosts', join(root, 'outside'));
  assert.deepEqual(await readEvidenceInSandbox(root, 'evidence.txt'), { path: 'evidence.txt', content: 'sample evidence' });
  await assert.rejects(() => readEvidenceInSandbox(root, 'outside'), /outside the repository/);
  await assert.rejects(() => readEvidenceInSandbox(root, '/etc/hosts'), /Invalid evidence path/);
});
