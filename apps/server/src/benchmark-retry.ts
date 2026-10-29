import { parseBenchmark, type Benchmark, type runBenchmark } from './benchmark.js';

type Result = Awaited<ReturnType<typeof runBenchmark>>;
type Attempt = { benchmark: Benchmark; result: Result };

export function extractRepairCommand(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid repair response.');
  const response = value as Record<string, unknown>;
  const object = (item: unknown): Record<string, unknown> => item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
  const experiment = object(response.experiment);
  const candidates = [response.command, object(response.benchmark).command, experiment.command, object(experiment.benchmark).command]
    .filter((item): item is string => typeof item === 'string' && !!item.trim());
  if (new Set(candidates).size > 1) throw new Error('Repair response contains conflicting commands.');
  return candidates[0] ?? null;
}

export async function withRepairDeadline<T>(run: () => Promise<T>, close: () => Promise<void>, signal: AbortSignal, timeoutMs = 15 * 60_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    if (signal.aborted) throw signal.reason;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error(`Repair planning timed out after ${timeoutMs / 1000} seconds.`)), timeoutMs);
    });
    return await Promise.race([run(), stopped]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await close();
  }
}

export async function runWithRetry(
  initial: Benchmark,
  execute: (benchmark: Benchmark) => Promise<Result>,
  repair: (benchmark: Benchmark, result: Result) => Promise<unknown>,
  signal?: AbortSignal,
  onAttempt: (attempts: Attempt[], retrying: boolean) => Promise<void> = async () => {},
) {
  const attempts: Attempt[] = [];
  const first = await execute(initial);
  attempts.push({ benchmark: initial, result: first });
  if (first.status !== 'failed' && first.status !== 'invalid_output') {
    await onAttempt([...attempts], false);
    return { benchmark: initial, ...first, attempts };
  }
  await onAttempt([...attempts], true);
  let repaired: Benchmark;
  try {
    const command = await repair(initial, first);
    if (signal?.aborted) throw signal.reason;
    if (typeof command !== 'string' || command === initial.command) throw new Error('No modified executable command was provided.');
    repaired = parseBenchmark({ ...initial, command })!;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return { benchmark: initial, ...first, attempts,
      retryError: error instanceof Error ? error.message.slice(0, 300) : 'Could not generate a repair.' };
  }
  const second = await execute(repaired);
  attempts.push({ benchmark: repaired, result: second });
  await onAttempt([...attempts], false);
  return { benchmark: repaired, ...second, attempts };
}
