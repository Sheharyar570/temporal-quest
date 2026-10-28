import { ActivityCancellationType, proxyActivities } from '@temporalio/workflow';
import type * as activities from './export.activities';
import type { ExportRequest, ExportResult } from './export.activities';

export const TASK_QUEUE = 'exports';

const { exportChunks } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '1s', // a silent worker is detected in 1s, not 10 minutes
  retry: { initialInterval: '1s', maximumAttempts: 5 },
  // On cancel, wait until the activity has finished cleaning up before the workflow moves on.
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
});

export async function exportWorkflow(req: ExportRequest): Promise<ExportResult> {
  return exportChunks(req);
}
