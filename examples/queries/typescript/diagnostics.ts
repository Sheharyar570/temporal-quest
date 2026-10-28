import {
  condition, defineQuery, defineSignal, proxyActivities, setCurrentDetails, setHandler, workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './diagnostics.activities';

export const TASK_QUEUE = 'shipments';

const { reserveStock } = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds' });

export interface Diagnostics {
  stage: string;
  waitingOn: string | null;
  historyLength: number;
  continueAsNewSuggested: boolean;
  lastTransitionAt: string;
}

export const carrierConfirmedSignal = defineSignal('carrierConfirmed');
export const diagnosticsQuery = defineQuery<Diagnostics>('diagnostics');

export async function shipmentWorkflow(orderId: string): Promise<string> {
  let stage = 'starting';
  let waitingOn: string | null = null;
  let confirmed = false;
  let lastTransitionAt = new Date().toISOString();

  const enter = (next: string, on: string | null, details: string) => {
    stage = next;
    waitingOn = on;
    lastTransitionAt = new Date().toISOString();
    setCurrentDetails(details); // shown in the Web UI next to the workflow
  };

  setHandler(carrierConfirmedSignal, () => { confirmed = true; }, { description: 'carrier confirms pickup' });
  setHandler(
    diagnosticsQuery,
    () => ({
      stage,
      waitingOn,
      historyLength: workflowInfo().historyLength,
      continueAsNewSuggested: workflowInfo().continueAsNewSuggested,
      lastTransitionAt,
    }),
    { description: 'support-friendly snapshot of where this workflow is stuck' },
  );

  enter('reserving', 'reserveStock activity', 'reserving stock for ' + orderId);
  await reserveStock(orderId);

  enter('awaiting_carrier', 'signal: carrierConfirmed', 'order ' + orderId + ': waiting for the carrier to confirm pickup');
  await condition(() => confirmed);

  enter('done', null, 'shipped');
  return 'shipped';
}
