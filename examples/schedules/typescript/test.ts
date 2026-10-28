/* Verification harness: runs each use case against a real local Temporal dev server (real time: Schedules need it). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ScheduleHandle, ScheduleOverlapPolicy as P } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as rep from './report.schedule';
import * as ovl from './overlap.schedule';
import * as syn from './sync.schedule';
import { source } from './sync.activities';
import * as syncActs from './sync.activities';

const uid = (p: string) => p + '-' + randomUUID().slice(0, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const done = (n: string) => { passed++; console.log('PASS', n); };
async function until(cond: () => Promise<boolean>, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return; await sleep(200); }
  throw new Error('condition not met');
}

async function main() {
  const env = await TestWorkflowEnvironment.createLocal();
  const client = env.client;
  const worker = (taskQueue: string, wf: string, activities: object = {}) =>
    Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: require.resolve(wf), activities });
  const n = async (h: ScheduleHandle) => (await h.describe()).info.numActionsTaken;
  const atLeast = (h: ScheduleHandle, k: number) => async () => (await n(h)) >= k;
  const actions = async (h: ScheduleHandle) =>
    (await h.describe()).info.recentActions.sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime()).map((a) => a.action.workflow.workflowId);
  const status = async (id: string) => (await client.workflow.getHandle(id).describe()).status.name;

  // ============================ use case 1: daily report
  await (await worker(rep.TASK_QUEUE, './report')).runUntil(async () => {
    {
      const sid = uid('cal');
      const h = await rep.create(client, sid);
      const d = await h.describe();
      assert.ok(d.info.nextActionTimes.length >= 3);
      for (const t of d.info.nextActionTimes) {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(t);
        const get = (k: string) => Number(parts.find((p) => p.type === k)!.value);
        assert.deepEqual([get('hour'), get('minute'), get('second')], [9, 0, 0]); // 09:00 New York, DST-aware; minute defaults to 0
      }
      console.log('next runs (UTC):', d.info.nextActionTimes.slice(0, 5).map((t) => t.toISOString().slice(5, 16)));
      await h.delete();
      done('report: calendar in a time zone, default fields');
    }
    {
      const sid = uid('trig');
      const h = await rep.create(client, sid);
      await h.trigger();
      await until(atLeast(h, 1));
      const [wid] = await actions(h);
      assert.ok(wid.startsWith(`report-${sid}-`)); // base ID + the action's timestamp
      const wf = client.workflow.getHandle(wid);
      assert.ok(String(await wf.result()).startsWith('emea report for '));
      const attrs = (await wf.describe()).searchAttributes as Record<string, unknown>;
      assert.deepEqual(attrs['TemporalScheduledById'], [sid]);
      assert.ok('TemporalScheduledStartTime' in attrs);
      await h.delete();
      done('report: trigger, run IDs and search attributes');
    }
    {
      const sid = uid('pause');
      const opts = rep.dailySchedule(sid, 'emea', 3);
      const h = await client.schedule.create({ ...opts, spec: { intervals: [{ every: '1s' }] } });
      await until(atLeast(h, 1));
      await h.pause('maintenance');
      const nAtPause = await n(h);
      const first = (await actions(h))[0];
      await sleep(3500);
      const d = await h.describe();
      assert.equal(d.info.numActionsTaken, nAtPause); // nothing new while paused
      assert.ok(d.state.paused && d.state.note === 'maintenance');
      assert.equal(await status(first), 'COMPLETED'); // the run already in flight was not touched
      await h.trigger(); // manual runs still work while paused
      await until(atLeast(h, nAtPause + 1));
      await h.unpause();
      const k = await n(h);
      await until(atLeast(h, k + 1)); // the spec is live again
      await h.delete();
      done('report: pause stops the spec but not manual triggers or runs in flight');
    }
    {
      const sid = uid('upd');
      const h = await rep.create(client, sid, 'emea');
      await h.update((prev) => ({ ...prev, action: { ...prev.action, args: ['apac', 0] } }));
      await sleep(1500);
      await h.trigger();
      await until(atLeast(h, 1));
      const [wid] = await actions(h);
      assert.ok(String(await client.workflow.getHandle(wid).result()).startsWith('apac report'));
      await h.delete();
      done('report: update changes the arguments of future runs');
    }
    {
      const sid = uid('lim');
      const opts = rep.dailySchedule(sid, 'emea');
      const h = await client.schedule.create({ ...opts, spec: { intervals: [{ every: '1s' }] }, state: { remainingActions: 2 } });
      await until(atLeast(h, 2));
      await sleep(3000);
      const d = await h.describe();
      assert.equal(d.info.numActionsTaken, 2);
      assert.equal(d.state.remainingActions, 0);
      console.log('after limit: paused =', d.state.paused, 'remaining =', d.state.remainingActions);
      await h.delete();
      done('report: limited actions stop after N runs');
    }
    {
      const sid = uid('del');
      await client.schedule.create(rep.dailySchedule(sid, 'emea', 3));
      const h = client.schedule.getHandle(sid);
      await h.trigger();
      await until(atLeast(h, 1));
      const [wid] = await actions(h);
      await h.delete();
      assert.equal(await status(wid), 'RUNNING');
      assert.ok(String(await client.workflow.getHandle(wid).result()).startsWith('emea report'));
      await assert.rejects(h.describe());
      done('report: deleting a schedule does not touch the runs it started');
    }
    {
      let seen: Array<[number[], string[]]> = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const sids = [uid('col'), uid('col')];
        const hs: ScheduleHandle[] = [];
        for (const s of sids) hs.push(await client.schedule.create({ ...rep.dailySchedule(s, 'emea'), action: { ...rep.dailySchedule(s, 'emea').action, workflowId: 'report-shared' } as any })); // the mistake: the same base for both
        await sleep(1000 - (Date.now() % 1000) + 50); // start of a fresh second, so both fire inside it
        await Promise.all(hs.map((h) => h.trigger()));
        await sleep(3000);
        const counts = await Promise.all(hs.map(n));
        const ids = (await Promise.all(hs.map(actions))).flat();
        for (const h of hs) await h.delete();
        seen.push([counts, ids]);
        if ([...counts].sort().join() === '0,1') break;
      }
      console.log('collision attempts:', JSON.stringify(seen));
      const [counts, ids] = seen[seen.length - 1];
      assert.equal([...counts].sort().join(), '0,1'); // one schedule's run never started; no error, no skip counter
      assert.equal(ids.length, 1);
      done('report: two schedules sharing a workflow ID base can collide and one run silently never starts');
    }
  });

  // ============================ use case 2: overlap policies
  const cases: Array<[string, P, { started: number; skipped?: number; statuses: string[]; peak: number }]> = [
    ['SKIP', P.SKIP, { started: 1, skipped: 2, statuses: ['COMPLETED'], peak: 1 }],
    ['BUFFER_ONE', P.BUFFER_ONE, { started: 2, skipped: 1, statuses: ['COMPLETED', 'COMPLETED'], peak: 1 }],
    ['BUFFER_ALL', P.BUFFER_ALL, { started: 3, skipped: 0, statuses: ['COMPLETED', 'COMPLETED', 'COMPLETED'], peak: 1 }],
    ['CANCEL_OTHER', P.CANCEL_OTHER, { started: 3, skipped: 0, statuses: ['CANCELLED', 'CANCELLED', 'COMPLETED'], peak: 1 }],
    ['TERMINATE_OTHER', P.TERMINATE_OTHER, { started: 3, skipped: 0, statuses: ['COMPLETED', 'TERMINATED', 'TERMINATED'], peak: 1 }],
    ['ALLOW_ALL', P.ALLOW_ALL, { started: 3, skipped: 0, statuses: ['COMPLETED', 'COMPLETED', 'COMPLETED'], peak: 3 }],
  ];
  await (await worker(ovl.TASK_QUEUE, './overlap')).runUntil(async () => {
    {
      // TypeScript only: a bare trigger() overrides the schedule's policy with ALLOW_ALL (see the SDK's doc comment)
      const h = await ovl.create(client, uid('bare'), P.SKIP, 4);
      for (let i = 0; i < 3; i++) { await h.trigger(); await sleep(1000); }
      await until(async () => (await actions(h)).length === 3);
      const d = await h.describe();
      assert.equal(d.info.numActionsTaken, 3);
      assert.equal(d.info.numActionsSkippedOverlap, 0); // a SKIP schedule skipped nothing
      await h.delete();
      done('overlap: TypeScript trigger() with no argument ignores the schedule SKIP policy (runs ALLOW_ALL)');
    }
    for (const [name, policy, expect] of cases) {
      const sid = uid(name.toLowerCase());
      const h = await ovl.create(client, sid, policy, 4);
      for (let i = 0; i < 3; i++) { await h.trigger(policy); await sleep(1000); } // t = 0 s, 1 s, 2 s: each arrives while the previous run is going
      const closed = async () => {
        const ids = await actions(h);
        const d = await h.describe();
        return d.info.runningActions.length === 0 && ids.length > 0 && (await Promise.all(ids.map(status))).every((s) => s !== 'RUNNING');
      };
      await until(closed, 40000);
      await sleep(1500); // let a buffered run that hasn't been picked up yet show itself
      await until(closed, 40000);
      const d = await h.describe();
      const ids = await actions(h);
      const runs = await Promise.all(ids.map(async (id) => { const x = await client.workflow.getHandle(id).describe(); return { s: x.startTime.getTime(), e: x.closeTime ? x.closeTime.getTime() : Infinity, st: x.status.name }; }));
      const peak = Math.max(...runs.map((r) => runs.filter((o) => o.s <= r.s && r.s < o.e).length));
      const got = { started: d.info.numActionsTaken, skipped: d.info.numActionsSkippedOverlap, statuses: runs.map((r) => r.st).sort(), peak };
      console.log(name, JSON.stringify(got));
      assert.equal(got.started, expect.started, name);
      assert.equal(got.skipped, expect.skipped, name);
      assert.deepEqual(got.statuses, expect.statuses, name);
      assert.equal(got.peak, expect.peak, name);
      await h.delete();
      done('overlap: ' + name);
    }
  });

  // ============================ use case 3: incremental sync
  await (await worker(syn.TASK_QUEUE, './sync', syncActs)).runUntil(async () => {
    const triggerAndWait = async (h: ScheduleHandle, k: number): Promise<any> => {
      await h.trigger(P.SKIP);
      await until(atLeast(h, k));
      const wf = client.workflow.getHandle((await actions(h)).at(-1)!);
      try { return await wf.result(); } catch (e) { return e; }
    };
    {
      source.reset();
      const sid = uid('wm');
      const h = await syn.create(client, sid, { every: '1d', paused: true });
      const r1 = await triggerAndWait(h, 1);
      assert.deepEqual(r1, { watermark: 5, previousRunFailed: false });
      assert.deepEqual(source.processed, [1, 2, 3, 4, 5]);
      source.rows.push(6, 7, 8);
      const r2 = await triggerAndWait(h, 2);
      assert.equal(r2.watermark, 8);
      assert.deepEqual(source.processed, [1, 2, 3, 4, 5, 6, 7, 8]); // run 2 saw only the 3 new rows
      source.up = false; source.rows.push(9);
      const r3 = await triggerAndWait(h, 3);
      assert.ok(r3 instanceof Error); // failed: no new result recorded
      source.up = true;
      const r4 = await triggerAndWait(h, 4);
      assert.equal(r4.watermark, 9);
      assert.equal(r4.previousRunFailed, true); // resumed from 8, and it could see the failure
      assert.deepEqual(source.processed, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const r5 = await triggerAndWait(h, 5);
      assert.equal(r5.previousRunFailed, false); // a success resets the last failure
      await h.delete();
      done('sync: last completion result is a watermark; a failed run does not move it');
    }
    {
      // a bare trigger() is ALLOW_ALL in TypeScript: those runs fed no last completion result and did not pause on failure
      source.reset();
      const h = await syn.create(client, uid('bare'), { every: '1d', paused: true });
      await h.trigger();
      await until(atLeast(h, 1));
      await sleep(1500);
      source.rows.push(6);
      await h.trigger();
      await until(atLeast(h, 2));
      await sleep(1500);
      assert.deepEqual(source.processed, [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 6]); // run 2 started from 0: no watermark was passed
      await h.delete();
      done('sync: TypeScript bare trigger() runs get no last completion result');
    }
    {
      source.reset();
      const sid = uid('pof');
      let h = await syn.create(client, sid, { every: '1d', pauseOnFailure: true });
      source.up = false;
      await h.trigger(P.SKIP);
      await until(atLeast(h, 1));
      await until(async () => (await h.describe()).state.paused);
      console.log('paused note:', (await h.describe()).state.note);
      await h.delete();
      source.up = true;
      for (const how of ['cancel', 'terminate']) {
        h = await syn.create(client, uid('pof-' + how), { every: '1d', pauseOnFailure: true, mode: 'hang' });
        await h.trigger(P.SKIP);
        await until(atLeast(h, 1));
        const wf = client.workflow.getHandle((await actions(h)).at(-1)!);
        await (how === 'cancel' ? wf.cancel() : wf.terminate());
        await until(async () => (await wf.describe()).status.name !== 'RUNNING');
        await sleep(1500);
        assert.ok(!(await h.describe()).state.paused, how);
        await h.delete();
      }
      done('sync: pause-on-failure pauses for failures but not for cancel or terminate');
    }
    {
      source.reset();
      const sid = uid('bf');
      const h = await syn.create(client, sid, { every: '1m', paused: true }); // paused: only the backfill runs
      const now = new Date(Math.floor(Date.now() / 60000) * 60000);
      await h.backfill([{ start: new Date(now.getTime() - 5 * 60000), end: new Date(now.getTime() - 1000), overlap: P.ALLOW_ALL }]);
      await until(atLeast(h, 5), 20000);
      await sleep(1000);
      const ids = await actions(h);
      const times = (await Promise.all(ids.map(async (id) => {
        const raw = (await client.workflow.getHandle(id).describe()).searchAttributes as Record<string, unknown[]>;
        return new Date(String(raw['TemporalScheduledStartTime'][0])).getTime();
      }))).sort();
      console.log('backfill slots:', times.map((t) => new Date(t).toISOString().slice(11, 19)), 'ids unique:', new Set(ids).size === ids.length);
      assert.equal(ids.length, 5);
      assert.equal(new Set(ids).size, 5); // one run per missed slot, each with its own ID
      assert.deepEqual(times, [5, 4, 3, 2, 1].map((m) => now.getTime() - m * 60000)); // start inclusive, each slot's own time
      assert.ok((await h.describe()).state.paused); // the schedule itself stayed paused
      await h.delete();
      done('sync: backfill runs the missed slots with their scheduled times');
    }
  });

  await env.teardown();
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
