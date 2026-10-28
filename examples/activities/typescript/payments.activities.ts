import { ApplicationFailure, Context } from '@temporalio/activity';

export interface CheckoutRequest {
  orderId: string;
  amount: number;
  cardToken: string;
  maxAttempts?: number;
  startToCloseSeconds?: number;
}
export interface ChargeResult {
  chargeId: string;
  attempt: number;
}

class CardDeclined extends Error {}
class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('rate limited');
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stand-in for a payment API. Idempotent by key, like Stripe's Idempotency-Key header. */
class FakeProvider {
  script: string[] = []; // one scripted behaviour per call, then "ok"
  charges = new Map<string, string>(); // idempotency key -> charge id
  calls: number[] = [];

  async charge(key: string, _amount: number, _cardToken: string): Promise<string> {
    this.calls.push(Date.now());
    const step = this.script.shift() ?? 'ok';
    if (step === 'decline') throw new CardDeclined('card declined');
    if (step.startsWith('rate_limit:')) throw new RateLimited(Number(step.split(':')[1]));
    if (step === 'fail_before') throw new Error('connection reset');
    if (step === 'hang') await sleep(30_000);
    if (!this.charges.has(key)) this.charges.set(key, 'ch_' + (this.charges.size + 1)); // same key => same charge
    if (step === 'fail_after') throw new Error('response lost, but the charge went through');
    return this.charges.get(key)!;
  }
}
export const provider = new FakeProvider();

export async function chargeCard(req: CheckoutRequest): Promise<ChargeResult> {
  const info = Context.current().info;
  // Stable across retries of THIS activity, different for every other activity.
  const key = info.workflowExecution?.runId + '-' + info.activityId;
  try {
    const chargeId = await provider.charge(key, req.amount, req.cardToken);
    return { chargeId, attempt: info.attempt };
  } catch (e) {
    if (e instanceof CardDeclined) {
      // Retrying can never help: fail immediately.
      throw ApplicationFailure.create({ message: e.message, type: 'CardDeclined', nonRetryable: true });
    }
    if (e instanceof RateLimited) {
      // The server told us when to come back: override the backoff for this one retry.
      throw ApplicationFailure.create({ message: 'rate limited', type: 'RateLimited', nextRetryDelay: e.retryAfterSeconds * 1000 });
    }
    throw e; // anything else (connection errors, ...) is retried with backoff
  }
}
