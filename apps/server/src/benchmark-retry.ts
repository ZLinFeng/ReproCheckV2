import { parseBenchmark, type Benchmark, type runBenchmark } from './benchmark.js';

type Result = Awaited<ReturnType<typeof runBenchmark>>;
type Attempt = { benchmark: Benchmark; result: Result };

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
