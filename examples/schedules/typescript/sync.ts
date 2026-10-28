/* Use case 3 (Hard): an incremental sync on a Schedule: last-completion-result as a watermark, pause on failure, backfill. */
import { proxyActivities, sleep, workflowInfo } from '@temporalio/workflow';
import type * as activities from './sync.activities';

const { syncRows } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });

export interface SyncResult { watermark: number; previousRunFailed: boolean }

export async function syncWorkflow(mode = 'sync'): Promise<SyncResult> {
  // the Schedule hands each run the result of the last SUCCESSFUL one: a free watermark, no database needed
  const last = workflowInfo().lastResult as SyncResult | undefined;
  const after = last?.watermark ?? 0;
  if (mode === 'hang') await sleep(60_000); // lets the test cancel or terminate a run
  const watermark = await syncRows(after);
  return { watermark, previousRunFailed: workflowInfo().lastFailure !== undefined };
}
