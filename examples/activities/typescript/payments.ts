import { ActivityFailure, ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from './payments.activities';
import type { CheckoutRequest } from './payments.activities';

export const TASK_QUEUE = 'payments';

export async function checkoutWorkflow(req: CheckoutRequest): Promise<string> {
  const { chargeCard } = proxyActivities<typeof activities>({
    startToCloseTimeout: (req.startToCloseSeconds ?? 2) * 1000, // per ATTEMPT
    retry: {
      initialInterval: '1s', // waits 1s, 2s, 4s, ... between attempts
      backoffCoefficient: 2,
      maximumInterval: '30s', // ...but never more than 30s
      maximumAttempts: req.maxAttempts ?? 6,
    },
  });

  try {
    const result = await chargeCard(req);
    return 'paid:' + result.chargeId + ':attempt' + result.attempt;
  } catch (e) {
    if (e instanceof ActivityFailure && e.cause instanceof ApplicationFailure && e.cause.type === 'CardDeclined') {
      return 'declined'; // a business outcome, not a crash
    }
    throw e; // retries exhausted or unexpected: let the workflow fail loudly
  }
}
