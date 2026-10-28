/* Step 1: add a fraud check, guarded by a patch. Executions that started before this deploy keep the old path. */
import { condition, defineSignal, patched, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './order.activities';

const { charge, fraudCheck, ship } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });
export const packedSignal = defineSignal('packed');

export async function orderWorkflow(order: string): Promise<string> {
  let packed = false;
  setHandler(packedSignal, () => { packed = true; });
  if (patched('fraud-check')) {
    await fraudCheck(order);
  }
  await charge(order);
  await condition(() => packed);
  await ship(order);
  return 'shipped';
}
