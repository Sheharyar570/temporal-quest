/* Use case 2 (Hard), deploy 0: what is running today. Executions started now will still be open when v2 ships. */
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './order.activities';

const { charge, ship } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });
export const packedSignal = defineSignal('packed');

export async function orderWorkflow(order: string): Promise<string> {
  let packed = false;
  setHandler(packedSignal, () => { packed = true; });
  await charge(order);
  await condition(() => packed); // open executions wait here for days
  await ship(order);
  return 'shipped';
}
