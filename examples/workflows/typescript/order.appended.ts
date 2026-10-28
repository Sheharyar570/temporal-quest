/* A subtler mistake: appending a step right where old executions are waiting. (test-only) */
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './order.activities';

const { charge, fraudCheck, ship } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });
export const packedSignal = defineSignal('packed');

export async function orderWorkflow(order: string): Promise<string> {
  let packed = false;
  setHandler(packedSignal, () => { packed = true; });
  await charge(order);
  await fraudCheck(order);
  await condition(() => packed);
  await ship(order);
  return 'shipped';
}
