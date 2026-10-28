import { Client } from '@temporalio/client';
import { addItemSignal, cartWorkflow, TASK_QUEUE } from './cart';

// "Create the cart if needed, then add an item" in ONE atomic call.
export async function addToCart(client: Client, customerId: string, item: string) {
  return client.workflow.signalWithStart(cartWorkflow, {
    workflowId: 'cart-' + customerId,
    taskQueue: TASK_QUEUE,
    args: [customerId],
    signal: addItemSignal,
    signalArgs: [item],
  });
}
