import { Client, ScheduleOptions } from '@temporalio/client';

export const TASK_QUEUE = 'reports';

export function dailySchedule(scheduleId: string, region: string, secondsOfWork = 0): ScheduleOptions {
  return {
    scheduleId,
    action: {
      type: 'startWorkflow',
      workflowType: 'reportWorkflow',
      args: [region, secondsOfWork],
      taskQueue: TASK_QUEUE,
      // the Schedule appends the action's timestamp (to the second) to this, so make the base unique PER SCHEDULE
      workflowId: `report-${scheduleId}`,
    },
    spec: {
      // every day at 09:00 New York time, DST included. minute and second default to 0.
      calendars: [{ hour: 9 }],
      timezone: 'America/New_York',
    },
    state: { note: 'daily report' },
  };
}

export async function create(client: Client, scheduleId: string, region = 'emea') {
  return client.schedule.create(dailySchedule(scheduleId, region));
}
