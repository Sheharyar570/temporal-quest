import { ApplicationFailure } from '@temporalio/activity';

export const holdLog: string[] = []; // test hook: how many real charges happened

export async function placePaymentHold(user: string, seats: string[]): Promise<string> {
  // In production: pre-authorise the card, passing an idempotency key to the provider.
  holdLog.push(user + ':' + seats.join(','));
  if (user === 'declined') throw ApplicationFailure.nonRetryable('payment hold declined', 'HoldDeclined');
  await new Promise((r) => setTimeout(r, 200)); // the slow external call that makes races possible
  return 'hold-' + user + '-' + seats.join('-');
}
