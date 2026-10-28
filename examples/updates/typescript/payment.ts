import { Mutex } from 'async-mutex';
import {
  allHandlersFinished, ApplicationFailure, condition, defineUpdate, proxyActivities, setHandler, sleep,
} from '@temporalio/workflow';
import type * as activities from './payment.activities';
import type { AuthRequest, AuthResult } from './payment.activities';

export const TASK_QUEUE = 'payments';
const SETTLEMENT_DELAY = '1 second'; // in production: hours or days

const { authorizeCard, capturePayment, sendReceipt } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
});

export const authorizeUpdate = defineUpdate<AuthResult, [AuthRequest]>('authorize');

export async function paymentWorkflow(orderId: string): Promise<string> {
  let auth: AuthResult | undefined;
  const lock = new Mutex();

  // With Update-With-Start the update is delivered before this function's first await,
  // so the handler MUST be registered up here.
  setHandler(authorizeUpdate, async (req) => {
    const result = await lock.runExclusive(async () => {
      if (auth !== undefined) return auth; // already decided: repeat calls get the same answer
      auth = await authorizeCard(req);
      return auth;
    });
    if (!result.approved) {
      // Throwing ApplicationFailure FAILS THE UPDATE (the caller sees it); the workflow lives on.
      throw ApplicationFailure.nonRetryable(result.reason, 'CardDeclined');
    }
    return result;
  });

  await condition(() => auth !== undefined);
  await condition(allHandlersFinished);
  const decided = auth as AuthResult | undefined; // set by the update handler
  if (!decided?.approved) return 'declined';

  // The caller already has its answer; the slow part continues in the background.
  await capturePayment(decided.authId);
  await sleep(SETTLEMENT_DELAY);
  await sendReceipt(orderId);
  return 'settled';
}
