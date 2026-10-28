import { Client } from '@temporalio/client';

export const TASK_QUEUE = 'sync';

export async function create(client: Client, scheduleId: string, o: { every?: string; pauseOnFailure?: boolean; paused?: boolean; mode?: string } = {}) {
  return client.schedule.create({
    scheduleId,
    action: { type: 'startWorkflow', workflowType: 'syncWorkflow', args: [o.mode ?? 'sync'], taskQueue: TASK_QUEUE, workflowId: 'sync-' + scheduleId },
    spec: { intervals: [{ every: o.every ?? '1m' }] },
    policies: { pauseOnFailure: o.pauseOnFailure ?? false },
    state: { paused: o.paused ?? false },
  });
}
