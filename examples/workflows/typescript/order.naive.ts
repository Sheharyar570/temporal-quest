/* The mistake: the same change as v2 with no patch. (test-only) */
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './order.activities';

const { charge, fraudCheck, ship } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });
export const packedSignal = defineSignal('packed');

export async function orderWorkflow(order: string): Promise<string> {
  let packed = false;
  setHandler(packedSignal, () => { packed = true; });
  await fraudCheck(order);
  await charge(order);
  await condition(() => packed);
  await ship(order);
  return 'shipped';
}
