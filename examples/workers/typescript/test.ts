/* Verification harness: runs each use case against a real local Temporal dev server. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import * as routingActs from './routing.activities';
import * as shutdownActs from './shutdown.activities';
import * as tuningActs from './tuning.activities';
import { installMetrics, tunedWorker } from './tuning.worker';

const PORT = 17233;
const METRICS_PORT = 9465;
const uid = (p: string) => p + '-' + randomUUID().slice(0, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const done = (n: string) => { passed++; console.log('PASS', n); };
async function until(cond: () => boolean, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (cond()) return; await sleep(100); }
  throw new Error('condition not met');
}
async function scrape() { return (await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`)).text(); }
function metric(text: string, name: string, labels: Record<string, string> = {}) {
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(name + '{') && !line.startsWith(name + ' ')) continue;
    if (Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) total += parseFloat(line.slice(line.lastIndexOf(' ') + 1));
  }
  return total;
}
async function runAll<T>(...ws: Worker[]) { /* helper: run workers until the returned stop() is called */
  const runs = ws.map((w) => w.run());
  return async () => { ws.forEach((w) => w.shutdown()); await Promise.all(runs); };
}

async function main() {
  installMetrics(METRICS_PORT);
  const env = await TestWorkflowEnvironment.createLocal({ server: { port: PORT } });
  const conn = env.nativeConnection;
  const mk = (taskQueue: string, wf: string | undefined, activities: object = {}, extra: object = {}) =>
    Worker.create({ connection: conn, taskQueue, workflowsPath: wf ? require.resolve(wf) : undefined, activities, ...extra });

  // ============================ use case 1: routing
  // each host is its own OS process (one runtime refuses two workers with the same task types on one queue)
  const startHost = async (dir: string, name: string, ghost = false) => {
    const logFile = join(dir, `${name}.log`);
    const child = spawn('node', [join(__dirname, 'routing.host.js'), `127.0.0.1:${PORT}`, 'default', name, logFile, ...(ghost ? ['ghost'] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((res) => child.stdout!.on('data', (b) => String(b).includes('ready') && res()));
    return { child, steps: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []) };
  };
  const runMedia = async (dir: string, hostNames: string[], ghostName: string | undefined, n: number) => {
    const hosts = await Promise.all(hostNames.map((h) => startHost(dir, h)));
    const ghost = ghostName ? await startHost(dir, ghostName, true) : undefined;
    const gpuAndWorkflow = [await mk('media-gpu', undefined, { renderOnGpu: routingActs.renderOnGpu }), await mk('media-flow', './routing')];
    const stop = await runAll(...gpuAndWorkflow);
    try {
      const results = await Promise.all(Array.from({ length: n }, (_, i) =>
        env.client.workflow.execute('mediaWorkflow', { taskQueue: 'media-flow', workflowId: uid('media'), args: [`f${i}.mp4`] }))) as Array<{ host: string; rendered: string }>;
      return { results, hosts, ghost };
    } finally { await stop(); }
  };
  {
    const dir = mkdtempSync(join(tmpdir(), 'w-'));
    const { results, hosts, ghost } = await runMedia(dir, ['a', 'b'], undefined, 8);
    try {
      results.forEach((r) => assert.ok(r.rendered.startsWith('rendered:')));
      const logs = hosts.map((h) => h.steps());
      assert.equal(logs[0].length + logs[1].length, 8 * 3);
      for (const l of logs) {
        assert.equal(l.filter((s) => s === 'download').length, l.filter((s) => s === 'process').length);
        assert.equal(l.filter((s) => s === 'download').length, l.filter((s) => s === 'upload').length); // whole jobs only
      }
      done('routing: file steps stay on one host; GPU work goes to the GPU queue');
    } finally { hosts.forEach((h) => h.child.kill('SIGKILL')); ghost?.child.kill('SIGKILL'); rmSync(dir, { recursive: true }); }
  }
  {
    const dir = mkdtempSync(join(tmpdir(), 'w-'));
    const { results, hosts, ghost } = await runMedia(dir, ['good'], 'ghost', 6);
    try {
      assert.deepEqual(new Set(results.map((r) => r.host)), new Set(['good']));
      assert.equal(ghost!.steps().length, 0); // the ghost answered lookups but never ran a file step
      done('routing: a host that vanished after the lookup is retried on another host');
    } finally { hosts.forEach((h) => h.child.kill('SIGKILL')); ghost?.child.kill('SIGKILL'); rmSync(dir, { recursive: true }); }
  }

  // ============================ use case 2: shutdown and crashes
  const marker = (d: string, job: string, attempt: number, kind: string) => join(d, `${job}.attempt${attempt}.${kind}`);
  const renderWorker = (extra: object = {}) => mk('render', './shutdown', shutdownActs, extra);
  const startRender = (job: string, d: string, secs: number) =>
    env.client.workflow.start('renderWorkflow', { taskQueue: 'render', workflowId: uid('r'), args: [job, d, secs] });

  {
    const d = mkdtempSync(join(tmpdir(), 'w-'));
    const a = await renderWorker({ shutdownGraceTime: '10s' });
    const ra = a.run();
    const h = await startRender('j1', d, 2);
    await until(() => existsSync(marker(d, 'j1', 1, 'started')));
    const t0 = Date.now(); a.shutdown(); await ra;
    assert.ok(Date.now() - t0 > 800); // shutdown waited for the activity
    assert.ok(!existsSync(marker(d, 'j1', 1, 'cancelled')));
    await (await renderWorker()).runUntil(async () => { assert.equal(await h.result(), 'j1:attempt1'); });
    done('shutdown: graceful shutdown lets the running activity finish (attempt 1)');
    rmSync(d, { recursive: true });
  }
  {
    const d = mkdtempSync(join(tmpdir(), 'w-'));
    const a = await renderWorker({ shutdownGraceTime: '500ms' });
    const ra = a.run();
    const h = await startRender('j2', d, 3);
    await until(() => existsSync(marker(d, 'j2', 1, 'started')));
    a.shutdown(); await ra;
    console.log('cancel reason seen by the activity:', readFileSync(marker(d, 'j2', 1, 'cancelled'), 'utf8'));
    await (await renderWorker()).runUntil(async () => { assert.equal(await h.result(), 'j2:attempt2'); });
    done('shutdown: a short grace period cancels the activity and another worker retries it');
    rmSync(d, { recursive: true });
  }
  {
    const d = mkdtempSync(join(tmpdir(), 'w-'));
    const child = spawn('node', [join(__dirname, 'crashing.worker.js'), `127.0.0.1:${PORT}`, 'default'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((res) => child.stdout!.on('data', (b) => String(b).includes('ready') && res()));
    try {
      const h = await startRender('j3', d, 6);
      await until(() => existsSync(marker(d, 'j3', 1, 'started')));
      const first = readFileSync(marker(d, 'j3', 1, 'started'), 'utf8');
      await (await renderWorker()).runUntil(async () => {
        const t0 = Date.now();
        child.kill('SIGKILL'); // no shutdown, no cleanup: the process just disappears
        await until(() => existsSync(marker(d, 'j3', 2, 'started')), 60000);
        console.log(`killed worker -> attempt 2 started after ${((Date.now() - t0) / 1000).toFixed(1)}s (heartbeat timeout 2s)`);
        assert.equal(await h.result(), 'j3:attempt2');
      });
      assert.equal(readFileSync(marker(d, 'j3', 2, 'started'), 'utf8'), String(process.pid));
      assert.notEqual(first, String(process.pid));
    } finally { child.kill('SIGKILL'); rmSync(d, { recursive: true }); }
    done('shutdown: a killed worker is noticed by the heartbeat timeout and the work moves');
  }

  // ============================ use case 3: tuning with metrics
  {
    const q = uid('names');
    const w = await tunedWorker(conn, q);
    await w.runUntil(async () => { await env.client.workflow.execute('workWorkflow', { taskQueue: q, workflowId: uid('w'), args: [0.1] }); });
    const text = await scrape();
    const names = new Set([...text.matchAll(/^(temporal_[a-z_]+?)(?:_bucket|_sum|_count)?[{ ]/gm)].map((m) => m[1]));
    console.log([...names].filter((n) => /slots|sticky|poller|schedule_to_start|workflow_task_execution/.test(n)).sort());
    for (const want of ['temporal_worker_task_slots_available', 'temporal_num_pollers', 'temporal_activity_schedule_to_start_latency', 'temporal_workflow_task_execution_latency']) assert.ok(names.has(want), want);
    done('tuning: the metric names in the docs exist');
  }
  const batch = (q: string, n: number, secs: number) => {
    tuningActs.RUNNING.now = 0; tuningActs.RUNNING.peak = 0;
    return Promise.all(Array.from({ length: n }, () => env.client.workflow.execute('workWorkflow', { taskQueue: q, workflowId: uid('b'), args: [secs] })));
  };
  const s2s = async (q: string) => { const t = await scrape(); return metric(t, 'temporal_activity_schedule_to_start_latency_sum', { task_queue: q }) / metric(t, 'temporal_activity_schedule_to_start_latency_count', { task_queue: q }); };
  {
    const small = uid('small'), big = uid('big');
    let free = -1, smallAvg = 0, bigAvg = 0;
    await (await tunedWorker(conn, small, { maxConcurrentActivities: 2 })).runUntil(async () => {
      const p = batch(small, 6, 1);
      await sleep(1200);
      free = metric(await scrape(), 'temporal_worker_task_slots_available', { worker_type: 'ActivityWorker', task_queue: small });
      await p;
      assert.equal(tuningActs.RUNNING.peak, 2);
      smallAvg = await s2s(small);
    });
    await (await tunedWorker(conn, big, { maxConcurrentActivities: 10 })).runUntil(async () => {
      await batch(big, 6, 1);
      assert.equal(tuningActs.RUNNING.peak, 6);
      bigAvg = await s2s(big);
    });
    console.log(`free activity slots mid-run (2 slots): ${free}; avg schedule-to-start ${smallAvg.toFixed(0)} ms (2 slots) vs ${bigAvg.toFixed(1)} ms (10 slots)`);
    assert.equal(free, 0);
    assert.ok(smallAvg > 800 && bigAvg < 400);
    done('tuning: too few activity slots show up as Schedule-To-Start latency and zero free slots');
  }
  {
    const waiters = async (q: string) => {
      const hs = await Promise.all(Array.from({ length: 4 }, () => env.client.workflow.start('waitWorkflow', { taskQueue: q, workflowId: uid('wait') })));
      await sleep(500);
      for (let r = 0; r < 2; r++) for (const h of hs) { await h.signal('poke'); await sleep(50); }
      return Promise.all(hs.map((h) => h.result()));
    };
    const stat = async (q: string) => { const t = await scrape(); return [metric(t, 'temporal_sticky_cache_miss', { task_queue: q }), metric(t, 'temporal_sticky_cache_hit', { task_queue: q })]; };
    const tiny = uid('tiny'), roomy = uid('roomy');
    let tm = 0, th = 0, rm = 0, rh = 0;
    // TypeScript refuses a cache of 1 ("can't be lower than 2 if maxCachedWorkflows is non-zero"), so the small cache is 2
    await (await tunedWorker(conn, tiny, { maxCachedWorkflows: 2 })).runUntil(async () => { assert.deepEqual(await waiters(tiny), [2, 2, 2, 2]); [tm, th] = await stat(tiny); });
    await (await tunedWorker(conn, roomy, { maxCachedWorkflows: 100 })).runUntil(async () => { assert.deepEqual(await waiters(roomy), [2, 2, 2, 2]); [rm, rh] = await stat(roomy); });
    console.log(`cache=2: miss ${tm} hit ${th}; cache=100: miss ${rm} hit ${rh}`);
    assert.ok(tm > rm && rh > th);
    done('tuning: a tiny sticky cache causes misses and replays but never wrong results');
  }

  await env.teardown();
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
