import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runBenchmark } from './benchmark.js';

export type SearchQuery = { claimId: string; query: string };
export type OnlineEvidence = {
  searches: { claimId: string; query: string; results: { url: string; title: string }[] }[];
  sources: { claimId: string; url: string; title: string; content: string; truncated: boolean }[];
  errors: { query?: string; url?: string; error: string }[];
};

export async function searchOnline(root: string, queries: SearchQuery[], signal?: AbortSignal): Promise<OnlineEvidence> {
  if (!queries.length) return { searches: [], sources: [], errors: [] };
  const script = await readFile(fileURLToPath(new URL('../config/online-search.py', import.meta.url)), 'utf8');
  const code = Buffer.from(script).toString('base64');
  const input = Buffer.from(JSON.stringify(queries.slice(0, 4))).toString('base64');
  const command = `python -I -c 'import base64,sys;sys.argv[1]=base64.b64decode(sys.argv[1]).decode();exec(base64.b64decode("${code}"))' ${input}`;
  const result = await runBenchmark(root, { runtime: 'python', network: true, command, metric: 'sources', unit: 'count',
    comparison: 'gte', expected: 0, basis: 'online search' }, signal, undefined, false);
  if (result.status !== 'measured') {
    const reason = 'error' in result ? result.error : result.status === 'failed' && 'stderr' in result ? result.stderr.slice(0, 300) : result.status;
    return { searches: [], sources: [], errors: [{ error: `Online search failed: ${reason || result.status}` }] };
  }
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object') throw new Error('invalid result');
    const data = value as OnlineEvidence;
    if (!Array.isArray(data.searches) || !Array.isArray(data.sources) || !Array.isArray(data.errors)) throw new Error('invalid result');
    return data;
  } catch {
    return { searches: [], sources: [], errors: [{ error: 'Online search returned an invalid result.' }] };
  }
}
