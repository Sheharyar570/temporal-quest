import { Mutex } from 'async-mutex';
import {
  allHandlersFinished, ApplicationFailure, condition, defineSignal, defineUpdate, proxyActivities, setHandler,
} from '@temporalio/workflow';
import type * as activities from './seats.activities';

export const TASK_QUEUE = 'events';
const MAX_SEATS_PER_BOOKING = 4;

const { placePaymentHold } = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds' });

export interface Reservation {
  user: string;
  seats: string[];
}
export interface Booking {
  bookingId: string;
  seats: string[];
  holdId: string;
}

export const reserveUpdate = defineUpdate<Booking, [Reservation]>('reserve');
export const closeSalesSignal = defineSignal('closeSales');

export async function eventWorkflow(seats: string[]): Promise<Record<string, string>> {
  const owner: Record<string, string> = Object.fromEntries(seats.map((s) => [s, ''])); // '' means free
  const lock = new Mutex();
  let salesClosed = false;

  setHandler(closeSalesSignal, () => { salesClosed = true; });

  setHandler(
    reserveUpdate,
    (r) =>
      lock.runExclusive(async () => {
        // AUTHORITATIVE check. The validator below ran earlier and can be stale by now.
        const taken = r.seats.filter((s) => owner[s] !== '');
        if (taken.length > 0) {
          throw ApplicationFailure.nonRetryable('seats already taken: ' + taken.join(', '), 'SeatTaken');
        }
        const holdId = await placePaymentHold(r.user, r.seats);
        for (const s of r.seats) owner[s] = r.user; // only mark seats once the money side succeeded
        return { bookingId: 'bk-' + holdId, seats: r.seats, holdId };
      }),
    {
      // Cheap, fast rejection. Never the only line of defence.
      validator: (r: Reservation) => {
        if (salesClosed) throw new Error('sales are closed');
        if (r.seats.length === 0 || r.seats.length > MAX_SEATS_PER_BOOKING) {
          throw new Error('choose 1 to ' + MAX_SEATS_PER_BOOKING + ' seats');
        }
        const unknown = r.seats.filter((s) => !(s in owner));
        if (unknown.length > 0) throw new Error('unknown seats: ' + unknown.join(', '));
      },
    },
  );

  await condition(() => salesClosed);
  await condition(allHandlersFinished); // let in-flight reservations finish
  return Object.fromEntries(Object.entries(owner).filter(([, u]) => u !== ''));
}
