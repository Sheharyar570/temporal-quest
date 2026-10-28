import { ApplicationFailure } from '@temporalio/common';

/** Stand-in for the system we sync from. */
export const source = {
  rows: [1, 2, 3, 4, 5],
  up: true,
  processed: [] as number[],
  reset() { this.rows = [1, 2, 3, 4, 5]; this.up = true; this.processed = []; },
};

export async function syncRows(after: number): Promise<number> {
  if (!source.up) throw ApplicationFailure.nonRetryable('source is down');
  const fresh = source.rows.filter((r) => r > after);
  source.processed.push(...fresh);
  return fresh.length ? Math.max(...fresh) : after;
}
