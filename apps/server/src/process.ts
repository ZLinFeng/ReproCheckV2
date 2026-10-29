import { spawn } from 'node:child_process';

export async function runProcess(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes?: number;
}) {
  if (options.signal?.aborted) throw options.signal.reason;
  return await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let exceeded = false;
    let forceKill: NodeJS.Timeout | undefined;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      forceKill ??= setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ }
      }, 1000);
      forceKill.unref();
    };
    const abort = () => stop();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024)) { exceeded = true; stop(); return; }
      if (stream === 'stdout') stdout.push(chunk);
      else stderr.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) return reject(options.signal.reason);
      if (exceeded) return reject(new Error('Process output exceeded the limit.'));
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut });
    });
  });
}
