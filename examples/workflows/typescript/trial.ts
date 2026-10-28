/* Use case 1 (Medium): a free-trial lifecycle built from durable timers, and why workflow code must be deterministic. */
import { condition, defineQuery, defineSignal, proxyActivities, setHandler, uuid4 } from '@temporalio/workflow';
import type * as activities from './trial.activities';

const { sendEmail } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });

export interface TrialRequest { user: string; reminderAfterDays?: number; lengthDays?: number }

export const convertSignal = defineSignal('convert');
export const endsAtQuery = defineQuery<string>('endsAt');

const DAY = 24 * 60 * 60 * 1000;

export async function trialWorkflow(req: TrialRequest): Promise<string> {
  const reminderAfter = (req.reminderAfterDays ?? 11) * DAY;
  const length = (req.lengthDays ?? 14) * DAY;
  let converted = false;
  const startedAt = Date.now(); // replay-safe clock inside the workflow sandbox: the time of the workflow task, recorded in history
  setHandler(convertSignal, () => { converted = true; });
  setHandler(endsAtQuery, () => new Date(startedAt + length).toISOString());

  const key = uuid4(); // replay-safe UUID: identical on every replay
  const send = (kind: string) => sendEmail(req.user, kind, key);

  await send('welcome');
  // waiting costs nothing while the timer is pending; a worker restart cannot lose it
  if (await condition(() => converted, reminderAfter)) { await send('thanks'); return 'converted'; }
  await send('reminder');
  if (await condition(() => converted, length - reminderAfter)) { await send('thanks'); return 'converted'; }
  await send('expired');
  return 'expired';
}
