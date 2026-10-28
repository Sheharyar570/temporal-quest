/* Verification harness: runs each use case against a real Temporal test server. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WorkflowExecutionAlreadyStartedError, WorkflowHandle } from '@temporalio/client';
import { WorkflowIdConflictPolicy as Conflict, WorkflowIdReusePolicy as Reuse } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import * as trialActs from './trial.activities';
import * as orderActs from './order.activities';
import * as importActs from './import.job.activities';

const uid = (p: string) => p + '-' + randomUUID().slice(0, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const done = (n: string) => { passed++; console.log('PASS', n); };
const EVT = temporal.api.enums.v1.EventType;

async function until(cond: () => Promise<boolean> | boolean, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return; await sleep(100); }
  throw new Error('condition not met');
}
const evTypes = async (h: WorkflowHandle) => (await h.fetchHistory()).events!.map((e) => e.eventType!);
const count = async (h: WorkflowHandle, t: number) => (await evTypes(h)).filter((x) => x === t).length;
const hasType = async (h: WorkflowHandle, t: number) => (await count(h, t)) > 0;
const rejects = async (p: Promise<unknown>, cls: Function, label: string) => {
  try { await p; } catch (e) { assert.ok(e instanceof cls, label + ': wrong error ' + e); return; }
  assert.fail(label + ': did not throw');
};

async function main() {
  const skip = await TestWorkflowEnvironment.createTimeSkipping();
  const local = await TestWorkflowEnvironment.createLocal();
  const worker = (env: TestWorkflowEnvironment, taskQueue: string, wf: string, activities: object = {}) =>
    Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: require.resolve(wf), activities });

  // ============================ use case 1: trial
  const kinds = () => trialActs.SENT.map(([, k]) => k);
  const startTrial = (env: TestWorkflowEnvironment, id = uid('trial')) => {
    trialActs.SENT.length = 0;
    return env.client.workflow.start('trialWorkflow', { taskQueue: 'trials', workflowId: id, args: [{ user: 'u1' }] });
  };
  await (await worker(skip, 'trials', './trial', trialActs)).runUntil(async () => {
    const t0 = Date.now();
    const h = await startTrial(skip);
    assert.equal(await h.result(), 'expired');
    assert.deepEqual(kinds(), ['welcome', 'reminder', 'expired']);
    assert.ok(Date.now() - t0 < 10000); // 14 simulated days
    done('trial: expires after 14 days in seconds');

    const h2 = await startTrial(skip);
    await skip.sleep('12 days');
    await h2.signal('convert');
    assert.equal(await h2.result(), 'converted');
    assert.deepEqual(kinds(), ['welcome', 'reminder', 'thanks']);
    done('trial: conversion after the reminder');
  });

  let h3!: WorkflowHandle;
  await (await worker(local, 'trials', './trial', trialActs)).runUntil(async () => {
    h3 = await startTrial(local);
    await until(async () => (await count(h3, EVT.EVENT_TYPE_WORKFLOW_TASK_COMPLETED)) >= 2);
  });
  const before = await (async () => { let v = ''; await (await worker(local, 'trials', './trial', trialActs)).runUntil(async () => { v = await h3.query<string>('endsAt'); await h3.signal('convert'); await h3.result(); }); return v; })();
  // a brand-new worker (no memory of the first) rebuilt the state from history and answered the query
  assert.ok(before.length > 0);
  const hist = await h3.fetchHistory();
  await Worker.runReplayHistory({ workflowsPath: require.resolve('./trial') }, hist);
  done('trial: replay of a real history succeeds; a new worker rebuilds state from it');

  // same workflow type name, but it no longer sends the welcome email first
  await rejects(Worker.runReplayHistory({ workflowsPath: require.resolve('./trial.skips') }, hist), DeterminismViolationError, 'skips');
  done('trial: changing the command order is a determinism violation');

  await (await worker(skip, 'trials', './trial', trialActs)).runUntil(async () => {
    const id = uid('trial');
    const h = await startTrial(skip, id);
    await rejects(skip.client.workflow.start('trialWorkflow', { taskQueue: 'trials', workflowId: id, args: [{ user: 'u1' }] }),
      WorkflowExecutionAlreadyStartedError, 'default conflict policy FAIL');
    const same = await skip.client.workflow.start('trialWorkflow', { taskQueue: 'trials', workflowId: id, args: [{ user: 'u1' }], workflowIdConflictPolicy: Conflict.USE_EXISTING });
    assert.equal(same.firstExecutionRunId, h.firstExecutionRunId);
    const repl = await skip.client.workflow.start('trialWorkflow', { taskQueue: 'trials', workflowId: id, args: [{ user: 'u1' }], workflowIdConflictPolicy: Conflict.TERMINATE_EXISTING });
    assert.notEqual(repl.firstExecutionRunId, h.firstExecutionRunId);
    assert.equal((await skip.client.workflow.getHandle(id, h.firstExecutionRunId).describe()).status.name, 'TERMINATED');
    await repl.signal('convert');
    assert.equal(await repl.result(), 'converted');
    const again = (reuse: Reuse) => skip.client.workflow.start('trialWorkflow', { taskQueue: 'trials', workflowId: id, args: [{ user: 'u1' }], workflowIdReusePolicy: reuse });
    await rejects(again(Reuse.REJECT_DUPLICATE), WorkflowExecutionAlreadyStartedError, 'reject duplicate');
    await rejects(again(Reuse.ALLOW_DUPLICATE_FAILED_ONLY), WorkflowExecutionAlreadyStartedError, 'failed only');
    const third = await again(Reuse.ALLOW_DUPLICATE);
    assert.ok(![h.firstExecutionRunId, repl.firstExecutionRunId].includes(third.firstExecutionRunId));
    await third.terminate();
    done('trial: workflow ID conflict and reuse policies');
  });

  // ============================ use case 2: patching
  const ow = (wf: string) => worker(local, 'orders', wf, orderActs);
  const startOrder = () => local.client.workflow.start('orderWorkflow', { taskQueue: 'orders', workflowId: uid('order'), args: ['o'] });
  const settled = async (h: WorkflowHandle) => (await count(h, EVT.EVENT_TYPE_WORKFLOW_TASK_COMPLETED)) >= 2;
  const replay = async (wf: string, h: WorkflowHandle | temporal.api.history.v1.IHistory) =>
    Worker.runReplayHistory({ workflowsPath: require.resolve(wf) }, 'fetchHistory' in h ? await h.fetchHistory() : h);
  const wfPath = (n: string) => './' + n;

  orderActs.CALLS.length = 0;
  let old!: WorkflowHandle;
  await (await ow(wfPath('order.v1'))).runUntil(async () => { old = await startOrder(); await until(() => settled(old)); });
  const hOld = await old.fetchHistory();
  await replay(wfPath('order.v2'), hOld); // patched code accepts the old history
  await rejects(replay(wfPath('order.naive'), hOld), DeterminismViolationError, 'naive vs old'); // the unpatched change would not

  orderActs.CALLS.length = 0;
  let neu!: WorkflowHandle;
  await (await ow(wfPath('order.v2'))).runUntil(async () => {
    await old.signal('packed');
    assert.equal(await old.result(), 'shipped');
    assert.deepEqual(orderActs.CALLS, ['ship']); // no fraud check for the order that started before the patch
    neu = await startOrder();
    await until(() => settled(neu));
    await neu.signal('packed');
    assert.equal(await neu.result(), 'shipped');
    assert.deepEqual(orderActs.CALLS, ['ship', 'fraud_check', 'charge', 'ship']);
  });
  const hNew = await neu.fetchHistory();
  const markers = hNew.events!.filter((e) => e.markerRecordedEventAttributes);
  assert.equal(markers.length, 1);
  console.log('marker name:', markers[0].markerRecordedEventAttributes!.markerName);
  await replay(wfPath('order.v3'), hNew); // deprecated patch still accepts histories that have the marker
  await rejects(replay(wfPath('order.v3'), hOld), DeterminismViolationError, 'v3 vs old'); // ...but not ones from before the patch
  done('patching: old execution continues on the old path, new on the new; deprecate step');

  orderActs.CALLS.length = 0;
  let stuck!: WorkflowHandle;
  await (await ow(wfPath('order.v1'))).runUntil(async () => { stuck = await startOrder(); await until(() => settled(stuck)); });
  await (await ow(wfPath('order.naive'))).runUntil(async () => {
    await stuck.signal('packed');
    await until(() => hasType(stuck, EVT.EVENT_TYPE_WORKFLOW_TASK_FAILED));
    assert.equal((await stuck.describe()).status.name, 'RUNNING'); // stuck, not failed
  });
  await (await ow(wfPath('order.v1'))).runUntil(async () => { assert.equal(await stuck.result(), 'shipped'); }); // roll back and it recovers
  done('patching: deploying the unpatched change blocks the open execution; rollback recovers it');

  orderActs.CALLS.length = 0;
  let open!: WorkflowHandle;
  await (await ow(wfPath('order.v1'))).runUntil(async () => { open = await startOrder(); await until(() => settled(open)); });
  const openHist = await open.fetchHistory();
  await replay(wfPath('order.appended'), openHist); // no later command contradicts it, so replay is happy
  await (await ow(wfPath('order.appended'))).runUntil(async () => { await open.signal('packed'); assert.equal(await open.result(), 'shipped'); });
  assert.deepEqual(orderActs.CALLS, ['charge', 'fraud_check', 'ship']);
  assert.ok(!(await hasType(open, EVT.EVENT_TYPE_WORKFLOW_TASK_FAILED)));
  let complete!: WorkflowHandle;
  await (await ow(wfPath('order.v1'))).runUntil(async () => {
    complete = await startOrder(); await until(() => settled(complete)); await complete.signal('packed'); await complete.result();
  });
  await rejects(replay(wfPath('order.appended'), complete), DeterminismViolationError, 'appended vs completed');
  done('patching: an appended step slips past replay of an open history but not a completed one');

  // ============================ use case 3: children + continue-as-new
  const iw = () => worker(local, 'imports', './import.job', importActs);
  const startImport = (job: string, extra: object = {}) => {
    importActs.DONE.length = 0;
    return local.client.workflow.start('importWorkflow', { taskQueue: 'imports', workflowId: job, args: [{ job, ...extra }] });
  };
  const status = async (id: string, runId?: string) => (await local.client.workflow.getHandle(id, runId).describe()).status.name;

  await (await iw()).runUntil(async () => {
    const job = uid('job');
    const h = await startImport(job);
    assert.equal(await h.result(), 100);
    assert.deepEqual([...importActs.DONE].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(await status(job, h.firstExecutionRunId), 'CONTINUED_AS_NEW');
    const last = await local.client.workflow.getHandle(job).fetchHistory();
    assert.ok(last.events!.length < 60);
    for (let p = 0; p < 10; p++) assert.equal(await status(`${job}-page-${p}`), 'COMPLETED');
    done('import: several runs, every page processed once, last run history is small');

    const a = await startImport(uid('a'), { pagesPerRun: 2 }); await a.result();
    const nSmall = (await local.client.workflow.getHandle(a.workflowId).fetchHistory()).events!.length;
    const b = await startImport(uid('b'), { pagesPerRun: 1000 }); await b.result();
    const nBig = (await local.client.workflow.getHandle(b.workflowId).fetchHistory()).events!.length;
    assert.ok(nBig > nSmall * 2, `${nBig} vs ${nSmall}`);
    done('import: without continue-as-new one run history is much longer');
  });

  await (await iw()).runUntil(async () => {
    const expected: Record<string, string> = { TERMINATE: 'TERMINATED', REQUEST_CANCEL: 'CANCELLED', ABANDON: 'COMPLETED' };
    for (const [policy, childStatus] of Object.entries(expected)) {
      const job = uid(policy.toLowerCase());
      const h = await startImport(job, { pageDelayMs: 3000, parentClose: policy });
      const child = `${job}-page-0`;
      await until(async () => { try { return (await status(child)) === 'RUNNING'; } catch { return false; } });
      await h.terminate();
      await until(async () => (await status(child)) !== 'RUNNING');
      assert.equal(await status(child), childStatus, policy);
      await sleep(3200);
    }
    done('import: parent close policy decides what happens to running children');

    const job = uid('cancel');
    const h = await startImport(job, { pageDelayMs: 3000 });
    const child = `${job}-page-0`;
    await until(async () => { try { return (await status(child)) === 'RUNNING'; } catch { return false; } });
    await h.cancel();
    await until(async () => (await status(child)) !== 'RUNNING');
    assert.equal(await status(child), 'CANCELLED');
    assert.equal(await status(job), 'CANCELLED');
    done('import: cancelling the parent cancels its children');
  });

  await skip.teardown(); await local.teardown();
  console.log(`\n${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
