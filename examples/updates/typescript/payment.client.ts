import { Client, WithStartWorkflowOperation } from '@temporalio/client';
import type { AuthRequest } from './payment.activities';
import { authorizeUpdate, paymentWorkflow, TASK_QUEUE } from './payment';

// Start the workflow AND get the authorisation answer back in one call.
export async function authorizeAndStart(client: Client, orderId: string, req: AuthRequest, requestId?: string) {
  const startOp = new WithStartWorkflowOperation(paymentWorkflow, {
    workflowId: 'payment-' + orderId,
    taskQueue: TASK_QUEUE,
    args: [orderId],
    workflowIdConflictPolicy: 'FAIL', // a second payment for this order is an error
  });
  const result = await client.workflow.executeUpdateWithStart(authorizeUpdate, {
    updateId: requestId ?? 'auth-' + orderId, // the Update ID doubles as an idempotency key
    args: [req],
    startWorkflowOperation: startOp,
  });
  return { result, handle: await startOp.workflowHandle() };
}
