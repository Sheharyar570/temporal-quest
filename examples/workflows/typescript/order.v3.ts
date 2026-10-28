/* Step 2: every execution that started before v2 has finished. Keep the marker call, drop the old branch. */
import { condition, defineSignal, deprecatePatch, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './order.activities';

const { charge, fraudCheck, ship } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });
export const packedSignal = defineSignal('packed');

export async function orderWorkflow(order: string): Promise<string> {
  let packed = false;
  setHandler(packedSignal, () => { packed = true; });
  deprecatePatch('fraud-check');
  await fraudCheck(order);
  await charge(order);
  await condition(() => packed);
  await ship(order);
  return 'shipped';
}
