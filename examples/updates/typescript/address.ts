import { condition, defineQuery, defineSignal, defineUpdate, setHandler } from '@temporalio/workflow';

export const TASK_QUEUE = 'orders';
const ETA_DAYS: Record<string, number> = { DE: 2, US: 5 }; // everything else: 9 days

export interface Address {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}
export interface AddressChange {
  address: Address;
  etaDays: number;
}
const etaDays = (a: Address) => ETA_DAYS[a.country] ?? 9;

export const changeAddressUpdate = defineUpdate<AddressChange, [Address]>('changeAddress');
export const markShippedSignal = defineSignal('markShipped');
export const markDeliveredSignal = defineSignal('markDelivered');
export const statusQuery = defineQuery<string>('status');

export async function orderWorkflow(orderId: string, initial: Address): Promise<string> {
  // Initialise state first, then register handlers, all before the first await.
  let address = initial;
  let status = 'processing' as 'processing' | 'shipped' | 'delivered';

  setHandler(markShippedSignal, () => { status = 'shipped'; });
  setHandler(markDeliveredSignal, () => { status = 'delivered'; });
  setHandler(statusQuery, () => status);

  setHandler(
    changeAddressUpdate,
    (next) => {
      address = next;
      return { address: next, etaDays: etaDays(next) }; // the caller gets a real answer
    },
    {
      // Runs BEFORE the update is accepted. Throw to reject: nothing is written to history.
      validator: (next) => {
        if (status !== 'processing') throw new Error('order already shipped, address can no longer change');
        if (!next.street.trim()) throw new Error('street is required');
        if (['DE', 'US'].includes(next.country) && !/^\d{5}$/.test(next.postalCode)) {
          throw new Error('postal code must be 5 digits');
        }
      },
    },
  );

  await condition(() => status === 'delivered');
  return orderId + ' delivered to ' + address.city;
}
