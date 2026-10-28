import { condition, defineQuery, defineSignal, setHandler } from '@temporalio/workflow';

export const TASK_QUEUE = 'tracking';
export const STAGES = ['packed', 'shipped', 'delivered'];

export interface ItemLine {
  sku: string;
  qty: number;
}
export interface ItemRequest {
  sku: string;
}
export interface OrderStatus {
  orderId: string;
  stage: string;
  stepsDone: string[];
  updatedAt: string; // ISO timestamp; Date is deterministic inside a workflow
}

export const advanceSignal = defineSignal('advance'); // warehouse / carrier systems push progress in
export const statusQuery = defineQuery<OrderStatus>('status');
export const itemQuery = defineQuery<ItemLine, [ItemRequest]>('item'); // queries can take arguments

export async function orderTrackingWorkflow(orderId: string, items: ItemLine[]): Promise<string> {
  const bySku = Object.fromEntries(items.map((i) => [i.sku, i]));
  let stage = 'received';
  const stepsDone: string[] = [];
  let updatedAt = new Date().toISOString();
  let advances = 0;

  setHandler(advanceSignal, () => { advances++; });

  // Queries: synchronous, read-only, no side effects, no awaits.
  setHandler(statusQuery, () => ({ orderId, stage, stepsDone: [...stepsDone], updatedAt }));
  setHandler(itemQuery, (req) => {
    const line = bySku[req.sku];
    // Any error thrown here reaches the client as a query error. It does NOT fail the workflow.
    if (!line) throw new Error('no such item: ' + req.sku);
    return line;
  });

  for (let i = 0; i < STAGES.length; i++) {
    await condition(() => advances > i);
    stage = STAGES[i];
    stepsDone.push(stage);
    updatedAt = new Date().toISOString();
  }
  return stage;
}
