/* Verification harness: runs each use case against a real local Temporal dev server. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkflowExecutionAlreadyStartedError, WorkflowUpdateFailedError, WorkflowUpdateStage } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as address from './address';
import * as seats from './seats';
import * as seatActs from './seats.activities';
import * as payment from './payment';
import * as paymentActs from './payment.activities';
import { authorizeAndStart } from './payment.client';

const uid = (p: string) => p + '-' + randomUUID().slice(0, 6);
const causeOf = (e: unknown) => (e as WorkflowUpdateFailedError).cause as ApplicationFailure;

async function rejects(p: Promise<unknown>, match?: string): Promise<WorkflowUpdateFailedError> {
  try { await p; } catch (e) {
    assert.ok(e instanceof WorkflowUpdateFailedError, 'expected WorkflowUpdateFailedError, got ' + e);
    if (match) assert.ok(String(e.cause?.message).includes(match), 'cause: ' + e.cause?.message);
    return e;
  }
  throw new Error('expected the update to fail');
}

async function acceptedCount(h: { fetchHistory(): Promise<{ events?: unknown[] | null }> }) {
  const hist = await h.fetchHistory();
  // EventType 'EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED' = 43? compare by name to stay version-proof
  const { temporal } = await import('@temporalio/proto');
  const T = temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED;
  return (hist.events as { eventType: number }[]).filter((e) => e.eventType === T).length;
}

async function main() {
  const env = await TestWorkflowEnvironment.createLocal();
  const worker = (taskQueue: string, wf: string, activities: object = {}) =>
    Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: require.resolve(wf), activities });
  const ok = (n: string) => console.log('PASS', n);
  let passed = 0; const done = (n: string) => { passed++; ok(n); };

  // ---- use case 1: address change ----
  await (await worker(address.TASK_QUEUE, './address')).runUntil(async () => {
    const oid = uid('o');
    const h = await env.client.workflow.start(address.orderWorkflow, {
      taskQueue: address.TASK_QUEUE, workflowId: oid, args: [oid, { street: '1 Main', city: 'Berlin', postalCode: '10115', country: 'DE' }],
    });
    const good = await h.executeUpdate(address.changeAddressUpdate, { args: [{ street: '2 Side', city: 'Munich', postalCode: '80331', country: 'DE' }] });
    assert.equal(good.etaDays, 2); assert.equal(good.address.city, 'Munich');
    await rejects(h.executeUpdate(address.changeAddressUpdate, { args: [{ street: '3 Rd', city: 'Paris', postalCode: '7500', country: 'DE' }] }), 'postal code');
    await rejects(h.executeUpdate(address.changeAddressUpdate, { args: [{ street: ' ', city: 'Paris', postalCode: '75001', country: 'DE' }] }), 'street');
    assert.equal(await acceptedCount(h), 1); // rejected updates left NO trace in history
    await h.signal(address.markShippedSignal);
    assert.equal(await h.query(address.statusQuery), 'shipped');
    await rejects(h.executeUpdate(address.changeAddressUpdate, { args: [{ street: '4 New', city: 'Bonn', postalCode: '53111', country: 'DE' }] }), 'already shipped');
    await h.signal(address.markDeliveredSignal);
    assert.equal(await h.result(), oid + ' delivered to Munich');
    done('address: validated change, rejections leave no history, shipped blocks changes');
  });

  // ---- use case 2: seat reservation ----
  await (await worker(seats.TASK_QUEUE, './seats', seatActs)).runUntil(async () => {
    const h = await env.client.workflow.start(seats.eventWorkflow, { taskQueue: seats.TASK_QUEUE, workflowId: uid('ev'), args: [['A1', 'A2', 'A3', 'B1']] });
    const reserve = (user: string, s: string[], updateId?: string) => h.executeUpdate(seats.reserveUpdate, { args: [{ user, seats: s }], updateId });

    const r = await Promise.allSettled([reserve('ann', ['A1']), reserve('bob', ['A1'])]);
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, JSON.stringify(r));
    const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    assert.ok(lost.reason instanceof WorkflowUpdateFailedError);
    assert.equal(causeOf(lost.reason).type, 'SeatTaken');
    assert.equal(seatActs.holdLog.length, 1); // the loser was NEVER charged

    const b1 = await reserve('cy', ['A2'], 'req-123');
    const b2 = await reserve('cy', ['A2'], 'req-123'); // client retry, same Update ID
    assert.deepEqual(b1, b2); assert.equal(seatActs.holdLog.length, 2);

    await rejects(reserve('declined', ['A3']));
    assert.deepEqual((await reserve('dee', ['A3'])).seats, ['A3']); // seat was left free

    const before = await acceptedCount(h);
    await rejects(reserve('x', []), 'choose 1 to'); await rejects(reserve('x', ['Z9']), 'unknown seats');
    await rejects(reserve('x', ['A1', 'A2', 'A3', 'B1', 'C1']), 'choose 1 to');
    assert.equal(await acceptedCount(h), before);

    const uh = await h.startUpdate(seats.reserveUpdate, { args: [{ user: 'eve', seats: ['B1'] }], waitForStage: WorkflowUpdateStage.ACCEPTED });
    assert.deepEqual((await uh.result()).seats, ['B1']);

    await h.signal(seats.closeSalesSignal);
    const final = await h.result();
    assert.deepEqual(Object.keys(final).sort(), ['A1', 'A2', 'A3', 'B1']); assert.equal(final.A2, 'cy');
    await assert.rejects(reserve('late', ['A1'])); // closed workflow: RPC error, not a validation error
    done('seats: race has one winner, loser not charged, update-id idempotency, declined hold frees seat');
  });

  // ---- use case 3: update-with-start ----
  await (await worker(payment.TASK_QUEUE, './payment', paymentActs)).runUntil(async () => {
    let oid = uid('ord');
    const { result, handle } = await authorizeAndStart(env.client, oid, { cardToken: 'tok_ok', amount: 100 });
    assert.ok(result.approved); assert.equal(result.authId, 'auth-tok_ok');
    assert.equal((await handle.describe()).status.name, 'RUNNING'); // caller has its answer; work continues
    const again = await authorizeAndStart(env.client, oid, { cardToken: 'tok_ok', amount: 100 }); // same update id
    assert.deepEqual(again.result, result);
    await assert.rejects(authorizeAndStart(env.client, oid, { cardToken: 'tok_ok', amount: 100 }, 'another-request'),
      (e: unknown) => e instanceof WorkflowExecutionAlreadyStartedError);
    assert.equal(await handle.result(), 'settled');
    done('payment: early return, same update id idempotent, FAIL policy blocks a different request');

    oid = uid('ord');
    await rejects(authorizeAndStart(env.client, oid, { cardToken: 'tok_declined', amount: 100 }), 'insufficient funds');
    assert.equal(await env.client.workflow.getHandle('payment-' + oid).result(), 'declined');
    done('payment: declined card fails the update, workflow ends declined');
  });

  await env.teardown();
  console.log(passed + ' passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
