/* Verification harness: runs each use case against a real (time-skipping) Temporal test server. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as cartActs from './cart.activities';
import * as approvalActs from './approval.activities';
import * as entityActs from './entity.activities';
import { addToCart } from './cart.client';
import { cartWorkflow, checkoutSignal, TASK_QUEUE as CARTS } from './cart';
import { approvalChainWorkflow, decideSignal, statusQuery, TASK_QUEUE as APPROVALS } from './approval';
import { accountWorkflow, applySignal, closeSignal, TASK_QUEUE as ACCOUNTS, AccountState } from './entity';

const uid = (p: string) => p + '-' + randomUUID().slice(0, 6);
const HOUR = 3600 * 1000;

async function main() {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const worker = (taskQueue: string, wf: string, activities: object) =>
    Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: require.resolve(wf), activities });
  const results: string[] = [];
  const ok = (n: string) => { results.push(n); console.log('PASS', n); };

  // ---- cart ----
  const cartW = await worker(CARTS, './cart', cartActs);
  await cartW.runUntil(async () => {
    let cust = uid('c');
    await addToCart(env.client, cust, 'book'); // starts
    await addToCart(env.client, cust, 'pen'); // signals the same running workflow
    let h = env.client.workflow.getHandle('cart-' + cust);
    await h.signal(checkoutSignal);
    assert.deepEqual(await h.result(), { status: 'ordered', orderId: 'order-' + cust + '-2', items: ['book', 'pen'] });
    ok('cart: signalWithStart + checkout');

    cust = uid('c');
    h = await addToCart(env.client, cust, 'book');
    const res = await h.result(); // time skips 24h
    assert.equal(res.status, 'abandoned');
    ok('cart: abandoned after 24h idle');

    cust = uid('c');
    await addToCart(env.client, cust, 'book');
    await env.sleep(23 * HOUR);
    await addToCart(env.client, cust, 'pen'); // resets the 24h clock
    await env.sleep(23 * HOUR);
    h = env.client.workflow.getHandle('cart-' + cust);
    assert.equal((await h.describe()).status.name, 'RUNNING');
    await h.signal(checkoutSignal);
    assert.equal((await h.result()).status, 'ordered');
    ok('cart: new item resets idle timer');
  });

  // ---- approval ----
  const apW = await worker(APPROVALS, './approval', approvalActs);
  await apW.runUntil(async () => {
    let rid = uid('r');
    let h = await env.client.workflow.start(approvalChainWorkflow, {
      taskQueue: APPROVALS, workflowId: rid, args: [{ requestId: rid, amount: 500, approvers: ['manager', 'director'] }],
    });
    await h.signal(decideSignal, { approver: 'mallory', approved: true });
    await h.signal(decideSignal, { approver: 'manager', approved: true, comment: 'ok' });
    assert.equal(await h.result(), 'approved');
    assert.deepEqual((await h.query(statusQuery)).audit, ['ignored decision from mallory', 'manager approved']);
    ok('approval: first level approves, outsider ignored');

    rid = uid('r');
    h = await env.client.workflow.start(approvalChainWorkflow, {
      taskQueue: APPROVALS, workflowId: rid, args: [{ requestId: rid, amount: 5000, approvers: ['manager', 'director'], levelTimeoutHours: 4 }],
    });
    await env.sleep(5 * HOUR);
    assert.equal((await h.query(statusQuery)).waitingOn, 'director');
    await h.signal(decideSignal, { approver: 'manager', approved: true }); // too late
    await h.signal(decideSignal, { approver: 'director', approved: false });
    assert.equal(await h.result(), 'rejected');
    assert.deepEqual((await h.query(statusQuery)).audit,
      ['manager timed out, escalating', 'ignored decision from manager', 'director rejected']);
    ok('approval: escalates on timeout, late signal ignored');

    rid = uid('r');
    const res = await env.client.workflow.execute(approvalChainWorkflow, {
      taskQueue: APPROVALS, workflowId: rid, args: [{ requestId: rid, amount: 5, approvers: ['a', 'b'], levelTimeoutHours: 1 }],
    });
    assert.equal(res, 'expired');
    ok('approval: expires when nobody answers');
  });

  // ---- entity ----
  const enW = await worker(ACCOUNTS, './entity', entityActs);
  await enW.runUntil(async () => {
    const acct = uid('acct');
    const init: AccountState = { accountId: acct, balance: 0, generation: 1, processed: 0, seen: [], pending: [], closing: false };
    const h = await env.client.workflow.start(accountWorkflow, { taskQueue: ACCOUNTS, workflowId: acct, args: [init] });
    const latest = env.client.workflow.getHandle(acct); // no runId => always the latest run
    for (let i = 0; i < 25; i++) {
      await latest.signal(applySignal, { eventId: 'e' + i, amount: 1 });
      if ([3, 4, 12].includes(i)) await latest.signal(applySignal, { eventId: 'e' + i, amount: 1 }); // at-least-once delivery
    }
    await latest.signal(closeSignal);
    const final = (await h.result()) as AccountState; // result() follows runs by default
    assert.equal(final.balance, 25);
    assert.ok(final.generation >= 3, 'generation ' + final.generation);
    ok('entity: dedupe, ordering, continue-as-new (generation ' + final.generation + ')');
  });

  await env.teardown();
  console.log(results.length + ' passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
