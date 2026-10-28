export const RUNNING = { now: 0, peak: 0 };

export async function work(seconds: number): Promise<void> {
  RUNNING.now++;
  RUNNING.peak = Math.max(RUNNING.peak, RUNNING.now);
  try { await new Promise((r) => setTimeout(r, seconds * 1000)); } finally { RUNNING.now--; }
}
