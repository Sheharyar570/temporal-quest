import { Client, ScheduleOverlapPolicy } from '@temporalio/client';

export const TASK_QUEUE = 'overlap';

export async function create(client: Client, scheduleId: string, overlap: ScheduleOverlapPolicy, seconds = 4) {
  return client.schedule.create({
    scheduleId,
    action: { type: 'startWorkflow', workflowType: 'slowJob', args: [seconds], taskQueue: TASK_QUEUE, workflowId: 'job-' + scheduleId },
    spec: {}, // no times: this demo fires the Schedule by hand with trigger() so the timing is exact
    policies: { overlap },
  });
}
