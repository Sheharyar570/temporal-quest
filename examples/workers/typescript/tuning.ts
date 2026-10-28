/* Use case 3 (Hard): reading a worker's own metrics to size it: task slots, Schedule-To-Start latency and the sticky cache. */
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './tuning.activities';

const { work } = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds' });

export async function workWorkflow(seconds: number): Promise<void> {
  await work(seconds);
}

export const pokeSignal = defineSignal('poke');

/** Waits for two pokes: each poke is a workflow task that needs the workflow's state (from cache, or by replay). */
export async function waitWorkflow(): Promise<number> {
  let pokes = 0;
  setHandler(pokeSignal, () => { pokes++; });
  await condition(() => pokes >= 2);
  return pokes;
}
