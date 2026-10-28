/* Same workflow type name as trial.ts, but it no longer sends the welcome email first. (test-only) */
import { sleep } from '@temporalio/workflow';

export async function trialWorkflow(req: { user: string; reminderAfterDays?: number }): Promise<string> {
  await sleep((req.reminderAfterDays ?? 11) * 24 * 60 * 60 * 1000);
  return 'x';
}
