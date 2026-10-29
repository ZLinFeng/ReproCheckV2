import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { runProcess } from './process.js';

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
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = '/usr/bin/sandbox-exec';
    const profile = '(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (literal "/dev/null"))';
    args = ['-p', profile, '/bin/cat', file];
  } else if (process.platform === 'linux') {
    command = 'bwrap';
    args = ['--die-with-parent', '--unshare-all', '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/bin', '/bin', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--ro-bind', base, '/workspace', '--chdir', '/workspace',
      '--', '/bin/cat', `/workspace/${rel}`];
  } else {
    throw new Error('No supported native sandbox is available on this platform.');
  }
  const result = await runProcess(command, args, { cwd: base, env, signal, timeoutMs: 10000, maxBytes: 210_000 });
  if (result.timedOut || result.code !== 0) throw new Error('The sandbox could not read the evidence.');
  return { path: rel, content: result.stdout };
}
