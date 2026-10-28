import {
  allHandlersFinished, condition, continueAsNew, defineQuery, defineSignal,
  proxyActivities, setHandler, workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './entity.activities';

export const TASK_QUEUE = 'accounts';
const MAX_EVENTS_PER_RUN = 10; // tiny on purpose so the demo continues-as-new quickly
const MAX_SEEN = 1000; // how many event IDs we remember for de-duplication

const { postLedgerEntry } = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds' });

export interface AccountEvent {
  eventId: string; // unique per business event, supplied by the sender
  amount: number;
}
export interface AccountState {
  accountId: string;
  balance: number;
  generation: number; // which run of this entity we are in
  processed: number; // events handled in the CURRENT run
  seen: string[];
  pending: AccountEvent[];
  closing: boolean; // carried too, or a close signal could be lost
}

export const applySignal = defineSignal<[AccountEvent]>('apply');
export const closeSignal = defineSignal('close');
export const balanceQuery = defineQuery<number>('balance');

export async function accountWorkflow(state: AccountState): Promise<AccountState> {
  const seen = new Set(state.seen); // a Set keeps insertion order

  setHandler(applySignal, (e) => {
    if (seen.has(e.eventId)) return; // duplicate delivery: already queued or processed
    seen.add(e.eventId);
    state.pending.push(e);
  });
  setHandler(closeSignal, () => {
    state.closing = true;
  });
  setHandler(balanceQuery, () => state.balance);

  const timeToContinueAsNew = () =>
    state.processed >= MAX_EVENTS_PER_RUN || workflowInfo().continueAsNewSuggested;

  while (true) {
    await condition(() => state.pending.length > 0 || state.closing);

    // Strict FIFO, one event at a time. Check the limit INSIDE the loop,
    // otherwise a big backlog is drained into a single ever-growing history.
    while (state.pending.length > 0 && !timeToContinueAsNew()) {
      const e = state.pending.shift()!;
      await postLedgerEntry(state.accountId, e.eventId, e.amount);
      state.balance += e.amount;
      state.processed++;
    }

    if (state.closing && state.pending.length === 0) return state;

    if (timeToContinueAsNew()) {
      await condition(allHandlersFinished); // never continue-as-new with a handler mid-flight
      return continueAsNew<typeof accountWorkflow>({
        ...state,
        generation: state.generation + 1,
        processed: 0,
        seen: [...seen].slice(-MAX_SEEN),
      });
    }
  }
}
