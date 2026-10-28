import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './cart.activities';

export const TASK_QUEUE = 'carts';
const ABANDON_AFTER = '24 hours';

const { createOrder, sendAbandonedCartEmail } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
});

export const addItemSignal = defineSignal<[string]>('addItem');
export const checkoutSignal = defineSignal('checkout');

export async function cartWorkflow(customerId: string) {
  const items: string[] = [];
  let checkedOut = false;
  let touched = false;

  // Register handlers before the first await so early signals are never missed.
  setHandler(addItemSignal, (item) => {
    items.push(item);
    touched = true;
  });
  setHandler(checkoutSignal, () => {
    checkedOut = true;
  });

  while (!checkedOut) {
    touched = false;
    // Wake on checkout OR on any new item; give up after 24h of silence.
    const woke = await condition(() => checkedOut || touched, ABANDON_AFTER);
    if (!woke) {
      await sendAbandonedCartEmail(customerId);
      return { status: 'abandoned', items };
    }
  }

  const orderId = await createOrder(customerId, items);
  return { status: 'ordered', orderId, items };
}
