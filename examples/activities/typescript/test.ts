/* Verification harness: runs each use case against a real local Temporal dev server. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ActivityFailure, ApplicationFailure, TimeoutFailure } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as payActs from './payments.activities';
import * as expActs from './export.activities';
import * as fanActs from './fanout.activities';
import { makeWorker } from './fanout.worker';
import * as extras from './extras.activities';

const uid = (p: string) => p + '-' + randomUUID().slice(0, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const done = (n: string) => { passed++; console.log('PASS', n); };

async function main() {
  const env = await TestWorkflowEnvironment.createLocal();
  const worker = (taskQueue: string, wf: string, activities: object = {}, extra: object = {}) =>
    Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: require.resolve(wf), activities, ...extra });

  // ============================ use case 1: payments
  const pay = async (run: () => Promise<void>) => { payActs.provider.script = []; payActs.provider.charges.clear(); payActs.provider.calls = []; await (await worker('payments', './payments', payActs)).runUntil(run); };
  const checkout = (o: Partial<payActs.CheckoutRequest> = {}) => {
    const req = { orderId: uid('o'), amount: 100, cardToken: 'tok', ...o };
    return env.client.workflow.execute('checkoutWorkflow', { taskQueue: 'payments', workflowId: req.orderId, args: [req] }) as Promise<string>;
  };

  await pay(async () => {
    payActs.provider.script = ['fail_before', 'fail_before', 'fail_before', 'ok'];
    assert.equal(await checkout(), 'paid:ch_1:attempt4');
    const t = payActs.provider.calls; const gaps = t.slice(1).map((x, i) => (x - t[i]) / 1000);
    gaps.forEach((g, i) => assert.ok(g >= [1, 2, 4][i] - 0.05 && g <= [1, 2, 4][i] + 0.7, 'gaps ' + gaps)); // 1s, 2s, 4s
    done('payments: exponential backoff 1s, 2s, 4s');
  });
  await pay(async () => {
    payActs.provider.script = ['fail_after', 'ok'];
    assert.equal(await checkout(), 'paid:ch_1:attempt2');
    assert.equal(payActs.provider.charges.size, 1); // same idempotency key => ONE charge
    done('payments: lost response retried without double charge');
  });
  await pay(async () => {
    payActs.provider.script = ['decline'];
    assert.equal(await checkout(), 'declined');
    assert.equal(payActs.provider.calls.length, 1);
    done('payments: non-retryable decline not retried');
  });
  await pay(async () => {
    payActs.provider.script = ['rate_limit:3', 'ok'];
    assert.equal(await checkout(), 'paid:ch_1:attempt2');
    const t = payActs.provider.calls; assert.ok(t[1] - t[0] >= 2900, 'server 3s delay beats the 1s backoff');
    done('payments: nextRetryDelay overrides backoff');
  });
  await pay(async () => {
    payActs.provider.script = ['hang', 'ok'];
    const t0 = Date.now();
    assert.equal(await checkout({ startToCloseSeconds: 1 }), 'paid:ch_1:attempt2');
    const el = Date.now() - t0; assert.ok(el >= 1000 && el < 6000, String(el));
    done('payments: start-to-close timeout is retried');
  });
  await pay(async () => {
    payActs.provider.script = Array(10).fill('fail_before');
    await assert.rejects(checkout({ maxAttempts: 3 }), (e: unknown) => {
      assert.ok(e instanceof WorkflowFailedError && e.cause instanceof ActivityFailure && e.cause.cause instanceof ApplicationFailure);
      assert.ok(/connection reset/.test((e.cause as ActivityFailure).cause!.message)); return true;
    });
    assert.equal(payActs.provider.calls.length, 3);
    done('payments: retries exhausted fails the workflow');
  });

  // ============================ use case 2: export
  const resetStorage = () => { expActs.storage.written = []; expActs.storage.events = []; expActs.storage.hangAt = null; expActs.storage.chunkMs = 0; };
  await (await worker('exports', './export', expActs)).runUntil(async () => {
    resetStorage(); expActs.storage.hangAt = 5;
    const t0 = Date.now();
    const res = (await env.client.workflow.execute('exportWorkflow', { taskQueue: 'exports', workflowId: uid('exp'), args: [{ exportId: 'e1', totalChunks: 10 }] })) as expActs.ExportResult;
    assert.deepEqual([res.attempt, res.resumedFrom, res.chunks], [2, 5, 10]);
    assert.deepEqual(expActs.storage.written, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // each exactly once, none redone
    const el = Date.now() - t0; assert.ok(el >= 2000 && el < 10000, String(el));
    done('export: heartbeat timeout detects wedged attempt, resumes from heartbeat details');

    resetStorage(); expActs.storage.chunkMs = 300;
    const h = await env.client.workflow.start('exportWorkflow', { taskQueue: 'exports', workflowId: uid('exp'), args: [{ exportId: 'e2', totalChunks: 40 }] });
    await sleep(1200); await h.cancel();
    await assert.rejects(h.result(), (e: unknown) => e instanceof WorkflowFailedError && e.cause?.name === 'CancelledFailure');
    assert.equal((await h.describe()).status.name, 'CANCELLED');
    assert.ok(expActs.storage.events.includes('lock released for e2')); // cleanup ran BEFORE the workflow finished
    assert.ok(expActs.storage.written.length > 0 && expActs.storage.written.length < 40);
    done('export: cancellation reaches heartbeating activity, workflow waits for cleanup');
  });

  // doc claim: cancellation is only delivered on heartbeat
  await (await worker('misc', './extras', extras)).runUntil(async () => {
    for (const [name, key] of [['slowNoHeartbeat', 'noHb'], ['slowWithHeartbeat', 'hb']] as const) {
      const h = await env.client.workflow.start('oneActivity', { taskQueue: 'misc', workflowId: uid('c'), args: [name] });
      await sleep(600); await h.cancel();
      await assert.rejects(h.result());
      await sleep(4000);
      void key;
    }
    assert.deepEqual(extras.SAW, { noHb: false, hb: true });
    done('cancellation is only delivered when the activity heartbeats');

    // doc claim: schedule-to-start timeout is never retried
    const t0 = Date.now();
    await assert.rejects(env.client.workflow.execute('queueDeadline', { taskQueue: 'misc', workflowId: uid('q') }), (e: unknown) => {
      assert.ok(e instanceof WorkflowFailedError && e.cause instanceof ActivityFailure && e.cause.cause instanceof TimeoutFailure);
      assert.equal(((e.cause as ActivityFailure).cause as TimeoutFailure).timeoutType, 'SCHEDULE_TO_START');
      return true;
    });
    assert.ok(Date.now() - t0 < 4000, 'NOT retried');
    done('schedule-to-start timeout is not retried');

    // local activity history shape + async completion
    const lh = await env.client.workflow.start('localAndAsync', { taskQueue: 'misc', workflowId: uid('l'), args: ['local'] });
    assert.equal(await lh.result(), '42');
    const types = new Set(((await lh.fetchHistory()).events ?? []).map((e) => e.eventType));
    assert.ok(types.has(temporal.api.enums.v1.EventType.EVENT_TYPE_MARKER_RECORDED));
    assert.ok(!types.has(temporal.api.enums.v1.EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED));
    const waitToken = async () => { for (let i = 0; i < 100 && extras.TOKENS.length === 0; i++) await sleep(50); return extras.TOKENS.shift()!; };
    let ah = await env.client.workflow.start('localAndAsync', { taskQueue: 'misc', workflowId: uid('a'), args: ['async'] });
    await env.client.activity.complete(await waitToken(), 'from the webhook');
    assert.equal(await ah.result(), 'from the webhook');
    ah = await env.client.workflow.start('localAndAsync', { taskQueue: 'misc', workflowId: uid('a'), args: ['async'] });
    await env.client.activity.fail(await waitToken(), ApplicationFailure.nonRetryable('vendor said no'));
    await assert.rejects(ah.result(), (e: unknown) => /vendor said no/.test(String(((e as WorkflowFailedError).cause as ActivityFailure).cause?.message)));
    done('local activity history shape + async completion (complete and fail)');
  });

  // ============================ use case 3: fan-out
  const runFanout = async (ids: string[], o: { latency?: number; throttle?: string[]; maxConcurrent?: number; perSecond?: number }) => {
    Object.assign(fanActs.api, { inFlight: 0, maxInFlight: 0, calls: 0, latencyMs: o.latency ?? 50, throttleOnce: new Set(o.throttle ?? []) });
    const w = await makeWorker(env.nativeConnection, { maxConcurrent: o.maxConcurrent, perSecond: o.perSecond });
    return w.runUntil(async () => {
      const t0 = Date.now();
      const res = (await env.client.workflow.execute('profileSyncWorkflow', { taskQueue: 'profiles', workflowId: uid('sync'), args: [ids] })) as { profiles: Record<string, string>; missing: string[]; failed: string[] };
      return { res, secs: (Date.now() - t0) / 1000 };
    });
  };
  {
    const ids = [...Array.from({ length: 36 }, (_, i) => 'u' + i), 'missing1', 'missing2'];
    const { res } = await runFanout(ids, { throttle: ['u3', 'u7', 'u9'], maxConcurrent: 5 });
    assert.equal(Object.keys(res.profiles).length, 36); assert.deepEqual(res.missing, ['missing1', 'missing2']); assert.deepEqual(res.failed, []);
    assert.ok(fanActs.api.maxInFlight > 1 && fanActs.api.maxInFlight <= 5, 'maxInFlight ' + fanActs.api.maxInFlight);
    assert.equal(fanActs.api.calls, ids.length + 3);
    done('fan-out: concurrency cap respected, partial failure handled, 429 retried');
    const ids2 = Array.from({ length: 40 }, (_, i) => 'u' + i);
    const unl = await runFanout(ids2, { latency: 10, maxConcurrent: 20 });
    const lim = await runFanout(ids2, { latency: 10, maxConcurrent: 20, perSecond: 20 });
    console.log('RATE unlimited=' + unl.secs.toFixed(2) + 's limited=' + lim.secs.toFixed(2) + 's');
    assert.ok(lim.secs >= 1.0 && lim.secs > unl.secs * 2);
    done('fan-out: per-second limit slows the burst');
  }

  await env.teardown();
  console.log(passed + ' passed');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
