import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local';
import { runProcess } from './process.js';

export const sandbox = new LocalSandboxProvider(new Context(), { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 });

// Only a trusted system reader runs here. Repository programs are never executed.
export async function readEvidenceInSandbox(root: string, path: string, signal?: AbortSignal) {
  if (!path || isAbsolute(path)) throw new Error('Invalid evidence path.');
  const candidate = resolve(root, path);
  const base = await realpath(root);
  const file = await realpath(candidate);
  const rel = relative(base, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Evidence path is outside the repository.');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 200_000) throw new Error('Evidence must be a regular file smaller than 200 KB.');
  const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C' };
  const confined = await sandbox.confine(['/bin/cat', file], { mode: 'read-only', workspaceRoot: base }, signal);
  const result = await runProcess(confined.argv[0], confined.argv.slice(1), { cwd: base, env, signal, timeoutMs: 10000, maxBytes: 210_000 });
  if (result.timedOut || result.code !== 0) throw new Error('The sandbox could not read the evidence.');
  return { path: rel, content: result.stdout };
}
