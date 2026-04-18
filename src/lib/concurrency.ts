// Minimal bounded-concurrency runner. `mapConcurrent(items, n, fn)`
// processes `items` in parallel chunks of at most `n` at a time,
// preserving order in the returned array. Used for send retries and
// stage dispatches so provider latency doesn't accumulate serially
// and hit Railway's request budget, while still capping the fan-out
// so we don't flood a rate-limited provider.

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = Math.max(1, Math.floor(concurrency));
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(n, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}
