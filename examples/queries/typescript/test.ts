/* Verification harness: runs each use case against a real local Temporal dev server. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, QueryNotRegisteredError, QueryRejectedError, ServiceError } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as tracking from './tracking';
import * as progress from './progress';
import * as progressActs from './progress.activities';
import * as diag from './diagnostics';
import * as diagActs from './diagnostics.activities';

const uid = (p: string) => p + '-' + randomUUID().slice(0, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(fn: () => Promise<T | false | null>, timeoutMs = 10000): Promise<T | false | null> {
  const end = Date.now() + timeoutMs;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(50); }
}
async function eventCount(h: { fetchHistory(): Promise<{ events?: unknown[] | null }> }) {
  return ((await h.fetchHistory()).events ?? []).length;
}

async function main() {
  const env = await TestWorkflowEnvironment.createLocal();
  const worker = (taskQueue: string, wf: string, activities: object = {}) =>
    Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: require.resolve(wf), activities });
  let passed = 0; const done = (n: string) => { passed++; console.log('PASS', n); };

  // ---- use case 1: order tracking ----
  const w1 = await worker(tracking.TASK_QUEUE, './tracking');
  const oid = uid('o');
  let h: Awaited<ReturnType<typeof env.client.workflow.start>>;
  await w1.runUntil(async () => {
    h = await env.client.workflow.start(tracking.orderTrackingWorkflow, {
      taskQueue: tracking.TASK_QUEUE, workflowId: oid, args: [oid, [{ sku: 'A-1', qty: 2 }, { sku: 'B-2', qty: 1 }]],
    });
    const st = await h.query(tracking.statusQuery);
    assert.equal(st.stage, 'received'); assert.deepEqual(st.stepsDone, []);
    assert.equal((await h.query(tracking.itemQuery, { sku: 'B-2' })).qty, 1);

    // a handler that throws => a client-side query error; the workflow is unaffected
    await assert.rejects(h.query(tracking.itemQuery, { sku: 'NOPE' }), (e: unknown) => {
      assert.ok(e instanceof QueryNotRegisteredError, 'got ' + (e as Error).constructor.name);
      assert.ok(String((e as Error).message).includes('no such item'));
      return true;
    });
    await assert.rejects(h.query('does_not_exist'), (e: unknown) => e instanceof QueryNotRegisteredError && /Registered queries/.test((e as Error).message));
    assert.equal((await h.describe()).status.name, 'RUNNING');

    const before = await eventCount(h);
    for (let i = 0; i < 20; i++) await h.query(tracking.statusQuery);
    assert.equal(await eventCount(h), before); // queries never write history

    await h.signal(tracking.advanceSignal); // signal -> state change is async: poll, don't assume read-your-writes
    assert.ok(await eventually(async () => (await h.query(tracking.statusQuery)).stage === 'packed'));
    await h.signal(tracking.advanceSignal); await h.signal(tracking.advanceSignal);
    assert.equal(await h.result(), 'delivered');

    const final = await h.query(tracking.statusQuery); // completed workflows can still be queried
    assert.equal(final.stage, 'delivered'); assert.deepEqual(final.stepsDone, tracking.STAGES);

    // reject non-open workflows (in TypeScript this is a CLIENT option, not a per-call argument)
    const strict = new Client({ connection: env.client.connection, workflow: { queryRejectCondition: 'NOT_OPEN' } });
    await assert.rejects(strict.workflow.getHandle(oid).query(tracking.statusQuery), (e: unknown) => e instanceof QueryRejectedError && e.status === temporal.api.enums.v1.WorkflowExecutionStatus.WORKFLOW_EXECUTION_STATUS_COMPLETED);
    done('tracking: status, args, errors, no history, closed workflow, reject condition');
  });
  // worker gone: even a COMPLETED workflow can't be queried, because replay needs a worker
  await assert.rejects(h!.query(tracking.statusQuery), (e: unknown) => {
    assert.ok(e instanceof ServiceError, 'got ' + (e as Error).constructor.name);
    const cause = e.cause as Error & { code?: number };
    assert.equal(cause.code, 9, 'FAILED_PRECONDITION'); assert.ok(/poller|worker/.test(cause.message), cause.message);
    return true;
  });
  done('tracking: no worker => FAILED_PRECONDITION');

  // ---- use case 2: progress ----
  await (await worker(progress.TASK_QUEUE, './progress', progressActs)).runUntil(async () => {
    const start = () => env.client.workflow.start(progress.importWorkflow, { taskQueue: progress.TASK_QUEUE, workflowId: uid('imp'), args: [{ totalRecords: 1000 }] });
    const a = await start();
    const seen: number[] = []; let p: progress.Progress; let polls = 0;
    for (;;) { p = await a.query(progress.progressQuery); polls++; seen.push(p.done + p.failed); if (p.finished) break; await sleep(50); }
    assert.deepEqual(seen, [...seen].sort((x, y) => x - y), 'progress never goes backwards');
    assert.ok(seen.some((s) => s > 0 && s < 1000), 'expected intermediate progress');
    assert.deepEqual([p.total, p.done, p.failed, p.percent, p.chunksDone], [1000, 972, 28, 100, 10]);
    assert.equal(p.recentErrors.length, 5); assert.equal(p.recentErrors[4], 'record 999: invalid email');
    assert.ok(polls > 5);
    assert.equal((await a.result()).done, 972);
    const aEvents = await eventCount(a);

    const b = await start(); await b.result();
    assert.equal(aEvents, await eventCount(b), 'polling did not add a single event to history');

    const c = await start();
    assert.ok(await eventually(async () => { const q = await c.query(progress.progressQuery); return q.etaSeconds !== null && q.etaSeconds > 0 && !q.finished; }));
    await c.result();
    done('progress: monotonic polling, bounded errors, no history growth, ETA');
  });

  // ---- use case 3: diagnostics ----
  await (await worker(diag.TASK_QUEUE, './diagnostics', diagActs)).runUntil(async () => {
    const id = uid('ship');
    const s = await env.client.workflow.start(diag.shipmentWorkflow, { taskQueue: diag.TASK_QUEUE, workflowId: id, args: [id] });
    const d = await eventually(async () => { const q = await s.query(diag.diagnosticsQuery); return q.stage === 'awaiting_carrier' ? q : null; });
    assert.ok(d && d.waitingOn === 'signal: carrierConfirmed' && d.historyLength >= 5 && d.continueAsNewSuggested === false);

    const trace = await s.query<string>('__stack_trace');
    assert.ok(trace.includes('shipmentWorkflow'), trace);
    const enhanced = await s.query<{ sdk: { name: string }; stacks: unknown[] }>('__enhanced_stack_trace');
    assert.equal(enhanced.sdk.name, 'typescript');
    const meta = await s.query<any>('__temporal_workflow_metadata');
    assert.equal(meta.definition.type, 'shipmentWorkflow');
    const q = Object.fromEntries(meta.definition.queryDefinitions.map((x: any) => [x.name, x.description]));
    assert.equal(q.diagnostics, 'support-friendly snapshot of where this workflow is stuck');
    for (const n of ['__stack_trace', '__enhanced_stack_trace', '__temporal_workflow_metadata']) assert.ok(n in q, n);
    assert.equal(meta.definition.signalDefinitions.find((x: any) => x.name === 'carrierConfirmed').description, 'carrier confirms pickup');
    assert.equal(meta.currentDetails, 'order ' + id + ': waiting for the carrier to confirm pickup');

    await s.signal(diag.carrierConfirmedSignal);
    assert.equal(await s.result(), 'shipped');
    const after = await s.query(diag.diagnosticsQuery);
    assert.equal(after.stage, 'done'); assert.equal(after.waitingOn, null);
    done('diagnostics: custom snapshot + __stack_trace, __enhanced_stack_trace, __temporal_workflow_metadata');
  });

  await env.teardown();
  console.log(passed + ' passed');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
