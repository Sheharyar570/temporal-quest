/* Use case 1 (Medium): a daily report on a Schedule: calendar + time zone, trigger, pause, update, limited runs, delete. */
import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';
import { sleep, workflowInfo } from '@temporalio/workflow';

const SCHEDULED_START = defineSearchAttributeKey('TemporalScheduledStartTime', SearchAttributeType.DATETIME); // set by the Schedule on every run it starts

export async function reportWorkflow(region: string, secondsOfWork = 0): Promise<string> {
  const scheduled = workflowInfo().typedSearchAttributes.get(SCHEDULED_START);
  await sleep(secondsOfWork * 1000);
  return `${region} report for ${scheduled ? scheduled.toISOString() : 'manual start'}`;
}
