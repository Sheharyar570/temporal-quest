'use strict';

/*
 * Each module is a list of sections. Types:
 *   html   – raw lesson HTML
 *   code   – { ts, py, title }
 *   widget – name from WIDGETS
 *   quiz   – questions [{ q, o: [options], a: correctIndex, why }]
 */
const MODULES = [
  /* ------------------------------------------------------------------ 1 */
  {
    id: 'why', icon: '🧭', title: 'Why Temporal?', time: '10 min', blurb: 'Durable execution and the big picture.',
    sections: [
      { type: 'html', html: `
        <p class="lead">Temporal lets you write long-running, failure-prone business logic as ordinary code, and guarantees it runs to completion even if servers crash, networks drop, or deployments happen mid-way.</p>
        <div class="analogy"><b>🎯 Analogy.</b> Imagine a project manager with a perfect notebook. Every time a task is finished they write it down. If they fall asleep (crash), a replacement reads the notebook and carries on from the last entry, never redoing finished work. <b>Temporal is that notebook plus the machinery to hand the project to a new manager.</b></div>
        <h2>The problem</h2>
        <p>Real processes span many steps and many systems: charge a card, reserve stock, ship, email. Any step can fail, time out, or run twice. Without help you end up hand-building queues, retry loops, cron jobs, state tables, and “reconciliation” scripts.</p>
        <h2>The architecture in one picture</h2>
        <div class="arch">
          <div class="node">Your app<small>Temporal Client</small></div>
          <div class="arrow">start / signal / query →</div>
          <div class="node core">Temporal Service<small>stores Event History, manages task queues &amp; timers</small></div>
          <div class="arrow">← long-poll tasks</div>
          <div class="node">Your Workers<small>run Workflow &amp; Activity code</small></div>
        </div>
        <div class="callout key"><b class="t">Key insight</b>The Temporal Service never runs your code. Your Workers do, in your infrastructure. The service only records what happened (the <b>Event History</b>) and hands out tasks.</div>
        <h2>Vocabulary you will meet</h2>
        <div class="cards">
          <div class="card"><div class="ico">🧠</div><h3>Workflow</h3><p>Durable orchestration code.</p></div>
          <div class="card"><div class="ico">⚙️</div><h3>Activity</h3><p>A single failure-prone side effect, retried automatically.</p></div>
          <div class="card"><div class="ico">🧑‍🏭</div><h3>Worker</h3><p>Process that polls a task queue and executes your code.</p></div>
          <div class="card"><div class="ico">📨</div><h3>Signal · Query · Update</h3><p>Three ways to talk to a running workflow.</p></div>
          <div class="card"><div class="ico">⏰</div><h3>Schedule</h3><p>Start workflows on a recurring basis.</p></div>
        </div>
        <h2>See durable execution with your own eyes</h2>
        <p>Run the steps, then kill the worker part-way. Watch what the new worker does when it starts.</p>` },
      { type: 'widget', name: 'crash' },
      { type: 'html', html: `
        <div class="callout tip"><b class="t">What you just saw: replay</b>A new worker re-runs the workflow function from the top, but every time it reaches an activity that already has a result in history it uses the recorded result instead of executing it. That is why workflow code must be <b>deterministic</b> (module 2).</div>
        <h2>Try it for real (5 minutes)</h2>` },
      { type: 'code', title: 'Terminal', ts: `# 1. Install the Temporal CLI (macOS)
brew install temporal

# 2. Start a local dev server (Web UI at http://localhost:8233)
temporal server start-dev

# 3. TypeScript project
npx @temporalio/create@latest my-first-app`,
        py: `# 1. Install the Temporal CLI (macOS)
brew install temporal

# 2. Start a local dev server (Web UI at http://localhost:8233)
temporal server start-dev

# 3. Python project
pip install temporalio` },
      { type: 'quiz', questions: [
        { q: 'Where does your workflow code actually execute?', o: ['Inside the Temporal Service', 'On Workers that you run', 'In the Temporal Web UI', 'In the client that started the workflow'], a: 1, why: 'The service only stores history and dispatches tasks; Workers run your code.' },
        { q: 'A worker crashes half-way through a workflow. What happens?', o: ['The workflow fails permanently', 'Everything restarts from step 1 and repeats side effects', 'Another worker replays history and continues where it stopped', 'You must manually restore a backup'], a: 2, why: 'Event History lets any worker rebuild state and continue; completed activities are not re-executed.' },
      ] },
    ],
  },

  /* ------------------------------------------------------------------ 2 */
  {
    id: 'workflows', icon: '🧠', title: 'Workflows', time: '12 min', blurb: 'Durable, deterministic orchestration code.',
    sections: [
      { type: 'html', html: `
        <p class="lead">A Workflow is a function whose progress is durably recorded. It decides <em>what happens next</em>; it does not perform side effects itself.</p>
        <div class="analogy"><b>🎯 Analogy.</b> A workflow is the recipe card, not the cook. It says “chop, then fry, then plate”, and survives the cook going home sick.</div>
        <h2>Your first workflow</h2>` },
      { type: 'code', title: 'workflows.ts / workflows.py', ts: `import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';

const { chargeCard, reserveStock, shipOrder } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
});

export async function orderWorkflow(orderId: string): Promise<string> {
  await chargeCard(orderId, 49);   // each await is a durable checkpoint
  await reserveStock(orderId);
  await shipOrder(orderId);
  return 'done';
}`,
        py: `from datetime import timedelta
from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from activities import charge_card, reserve_stock, ship_order

@workflow.defn
class OrderWorkflow:
    @workflow.run
    async def run(self, order_id: str) -> str:
        opts = dict(start_to_close_timeout=timedelta(seconds=30))
        await workflow.execute_activity(charge_card, args=[order_id, 49], **opts)
        await workflow.execute_activity(reserve_stock, order_id, **opts)
        await workflow.execute_activity(ship_order, order_id, **opts)
        return "done"` },
      { type: 'html', html: `
        <h2>The determinism contract</h2>
        <p>Because workers <b>replay</b> your code, running it twice with the same history must make the same decisions in the same order. So workflow code must not do I/O, read clocks directly, or use unseeded randomness. Temporal provides deterministic replacements:</p>
        <table><tr><th>Need</th><th>Do this in a Workflow</th></tr>
          <tr><td>Wait</td><td><code>sleep()</code> / <code>workflow.sleep()</code> (durable timer, can last months)</td></tr>
          <tr><td>Current time</td><td><code>Date.now()</code> in the TS sandbox is made deterministic; in Python use <code>workflow.now()</code></td></tr>
          <tr><td>Random / UUID</td><td><code>uuid4()</code> from the workflow package; <code>workflow.uuid4()</code> / <code>workflow.random()</code> in Python</td></tr>
          <tr><td>Talk to the outside world</td><td>Call an <b>Activity</b></td></tr></table>
        <div class="callout warn"><b class="t">Changing workflow code</b>Deploying new code while old executions are still running can break replay (a “non-determinism error”). The execution is not failed: its workflow task fails and it stays <b>Running</b> (blocked) until compatible code is deployed. Temporal offers <b>patching</b> and <b>Worker Versioning</b> (the docs recommend the latter); the deep dive walks through patching with real replay tests.</div>
        <h2>Workflow identity &amp; lifecycle</h2>
        <ul><li><b>Workflow ID</b>: your business key (e.g. <code>order-1001</code>). Only one <em>open</em> workflow per ID can ever exist; by default (conflict policy <code>FAIL</code>) a second start is rejected, which gives you free de-duplication. <code>USE_EXISTING</code> and <code>TERMINATE_EXISTING</code> change that.</li>
        <li><b>Run ID</b>: unique per execution (retries, continue-as-new create new runs under the same Workflow ID).</li>
        <li><b>Status</b>: Running → Completed / Failed / Cancelled / Terminated / TimedOut / ContinuedAsNew.</li></ul>
        <h2>Game: sort the code</h2>` },
      { type: 'widget', name: 'sorter' },
      { type: 'quiz', questions: [
        { q: 'Why must workflow code be deterministic?', o: ['To make it run faster', 'Because it is replayed from Event History to rebuild state', 'Because the Temporal Service executes it', 'Only to make unit tests easier'], a: 1, why: 'Replay must reach the same decisions as the original run, otherwise history and code diverge.' },
        { q: 'You need to wait 14 days before sending a reminder. What do you use?', o: ['A cron job and a database flag', 'setTimeout in the worker', 'sleep() inside the workflow', 'An activity that loops for 14 days'], a: 2, why: 'Workflow timers are durable and cost nothing while waiting.' },
        { q: 'You start a second workflow with the same Workflow ID while the first is still running. By default…', o: ['Both run', 'The second start is rejected', 'The first is terminated', 'They merge'], a: 1, why: 'Workflow ID uniqueness among running executions gives you built-in idempotency.' },
      ] },
    ],
  },

  /* ------------------------------------------------------------------ 3 */
  {
    id: 'activities', icon: '⚙️', title: 'Activities', time: '12 min', blurb: 'Side effects, retries and timeouts.',
    sections: [
      { type: 'html', html: `
        <p class="lead">An Activity is a normal function that does one thing that can fail: call an API, query a database, send an email. Temporal retries it for you, with backoff, until it succeeds or you tell it to give up.</p>
        <div class="analogy"><b>🎯 Analogy.</b> If the workflow is the manager, an activity is the delivery driver. If the van breaks down, the manager does not panic: they reschedule the delivery according to the policy.</div>
        <h2>Defining and calling an activity</h2>` },
      { type: 'code', title: 'activities + options', ts: `// activities.ts: plain functions, any I/O allowed
export async function chargeCard(orderId: string, amount: number): Promise<string> {
  const res = await fetch('https://payments.example.com/charge', {
    method: 'POST',
    body: JSON.stringify({ orderId, amount }),
  });
  if (!res.ok) throw new Error('payment service returned ' + res.status);
  return (await res.json()).chargeId;
}

// workflows.ts: how the workflow calls it
const { chargeCard } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',                   // REQUIRED: max time for ONE attempt
  retry: { maximumAttempts: 5, backoffCoefficient: 2 }, // optional: defaults to unlimited retries
});`,
        py: `# activities.py
from temporalio import activity

@activity.defn
async def charge_card(order_id: str, amount: int) -> str:
    async with httpx.AsyncClient() as http:
        res = await http.post("https://payments.example.com/charge",
                              json={"orderId": order_id, "amount": amount})
        res.raise_for_status()
        return res.json()["chargeId"]

# in the workflow
await workflow.execute_activity(
    charge_card, args=[order_id, 49],
    start_to_close_timeout=timedelta(seconds=10),       # REQUIRED
    retry_policy=RetryPolicy(maximum_attempts=5, backoff_coefficient=2.0),
)` },
      { type: 'html', html: `
        <h2>Retries: the superpower</h2>
        <p>By default activities retry <b>forever</b> with exponential backoff (1s, 2s, 4s… capped at 100× the initial interval). You tune: <code>initialInterval</code>, <code>backoffCoefficient</code>, <code>maximumInterval</code>, <code>maximumAttempts</code> and <code>nonRetryableErrorTypes</code>. Play with it:</p>` },
      { type: 'widget', name: 'retry' },
      { type: 'html', html: `
        <h2>Timeouts: pick your clock</h2>
        <table><tr><th>Timeout</th><th>Measures</th><th>Use for</th></tr>
        <tr><td><code>startToCloseTimeout</code></td><td>One attempt, from start to finish</td><td>Almost always set this</td></tr>
        <tr><td><code>scheduleToCloseTimeout</code></td><td>Total time including all retries</td><td>An overall deadline</td></tr>
        <tr><td><code>scheduleToStartTimeout</code></td><td>Time waiting in the queue</td><td>Detect “no workers”. <b>Never retried.</b> (Usually monitor the schedule-to-start latency metric instead)</td></tr>
        <tr><td><code>heartbeatTimeout</code></td><td>Gap between heartbeats</td><td>Long-running activities: detect a dead worker in seconds, not hours</td></tr></table>
        <div class="callout key"><b class="t">Idempotency</b>Activities are <b>at-least-once</b>: a retry may re-run an activity that actually succeeded but whose result was lost. Make side effects idempotent, e.g. pass an idempotency key built from the workflow <em>run</em> ID plus the activity ID (stable across retries of one activity) to your payment provider.</div>
        <h3>Telling Temporal not to retry</h3>` },
      { type: 'code', title: 'Non-retryable errors & heartbeats', ts: `import { ApplicationFailure, heartbeat } from '@temporalio/activity';

export async function chargeCard(orderId: string): Promise<void> {
  if (await isDeclined(orderId)) {
    // Retrying will never help, so fail the activity immediately
    throw ApplicationFailure.nonRetryable('Card declined', 'CardDeclined');
  }
}

export async function processBigFile(path: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    await processChunk(path, i);
    heartbeat(i);   // "I'm alive, progress = i"
  }
}`,
        py: `from temporalio.exceptions import ApplicationError
from temporalio import activity

@activity.defn
async def charge_card(order_id: str) -> None:
    if await is_declined(order_id):
        # Retrying will never help, so fail the activity immediately
        raise ApplicationError("Card declined", type="CardDeclined", non_retryable=True)

@activity.defn
async def process_big_file(path: str) -> None:
    for i in range(1000):
        await process_chunk(path, i)
        activity.heartbeat(i)   # "I'm alive, progress = i"` },
      { type: 'html', html: `
        <div class="callout warn"><b class="t">Good to know (all verified by running it)</b><ul>
          <li><b>Retries are done by the Temporal Service and add no events to history.</b> An activity that failed 3 times leaves one scheduled, one started and one completed event.</li>
          <li><b>Plain exceptions are retried too, including bugs.</b> With the default policy that is forever: set limits, or throw a non-retryable <code>ApplicationError</code>/<code>ApplicationFailure</code>.</li>
          <li>The server’s retry timers have a <b>1 second floor</b> in our tests: 100 ms and 500 ms initial intervals both waited 1 s. Use whole seconds.</li>
          <li><b>Schedule-To-Start timeouts are never retried</b>, whatever the retry policy says.</li>
          <li><code>next_retry_delay</code> / <code>nextRetryDelay</code> on the thrown failure overrides the backoff, ideal for a 429’s <code>Retry-After</code>.</li>
          <li><b>Cancellation only reaches an activity when it heartbeats</b>, and heartbeats are throttled (~0.8 × the heartbeat timeout).</li>
        </ul></div>` },
      { type: 'quiz', questions: [
        { q: 'Which timeout is required when scheduling an activity (you must set at least one of two)?', o: ['heartbeatTimeout', 'startToCloseTimeout (or scheduleToCloseTimeout)', 'workflowRunTimeout', 'queueTimeout'], a: 1, why: 'You must set startToCloseTimeout or scheduleToCloseTimeout.' },
        { q: 'An activity charged a card but the worker died before reporting success. On retry the card might be charged again. What is the right fix?', o: ['Disable retries', 'Make the activity idempotent with an idempotency key', 'Move the call into the workflow', 'Catch the error and ignore it'], a: 1, why: 'Activities are at-least-once; idempotency keys make repeats harmless.' },
        { q: 'What does a heartbeat give you for a 2-hour activity?', o: ['Faster execution', 'Quick detection of a dead worker and the ability to resume from progress', 'Automatic parallelism', 'Longer timeouts'], a: 1, why: 'With a heartbeatTimeout, a silent worker is detected in seconds and the retry can resume from the last heartbeat details.' },
      ] },
    ],
  },

  /* ------------------------------------------------------------------ 4 */
  {
    id: 'workers', icon: '🧑‍🏭', title: 'Workers & Task Queues', time: '10 min', blurb: 'Who actually runs your code.',
    sections: [
      { type: 'html', html: `
        <p class="lead">A Worker is a long-running process you deploy. It <b>long-polls</b> a named Task Queue for work, runs your workflow and activity code, and reports results back.</p>
        <div class="analogy"><b>🎯 Analogy.</b> The task queue is a ticket board in a workshop. Workers are mechanics who grab tickets they know how to handle. Add mechanics for more throughput; if everyone goes home the tickets simply wait.</div>
        <h2>Running a worker</h2>` },
      { type: 'code', title: 'worker', ts: `import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';

async function run() {
  const connection = await NativeConnection.connect({ address: 'localhost:7233' });
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: 'orders',                          // must match what the client uses!
    workflowsPath: require.resolve('./workflows'),
    activities,
  });
  await worker.run();                             // runs until shutdown
}
run().catch((err) => { console.error(err); process.exit(1); });`,
        py: `import asyncio
from temporalio.client import Client
from temporalio.worker import Worker

async def main():
    client = await Client.connect("localhost:7233")
    worker = Worker(
        client,
        task_queue="orders",               # must match what the client uses!
        workflows=[OrderWorkflow],
        activities=[charge_card, reserve_stock, ship_order],
    )
    await worker.run()                     # runs until shutdown

asyncio.run(main())` },
      { type: 'html', html: `<h2>Starting a workflow from a client</h2>` },
      { type: 'code', title: 'client', ts: `import { Client } from '@temporalio/client';
import { orderWorkflow } from './workflows';

const client = new Client();
const handle = await client.workflow.start(orderWorkflow, {
  taskQueue: 'orders',            // the queue the worker polls
  workflowId: 'order-1001',       // your business key
  args: ['1001'],
});
console.log('started', handle.workflowId);
console.log('result:', await handle.result());`,
        py: `client = await Client.connect("localhost:7233")
handle = await client.start_workflow(
    OrderWorkflow.run, "1001",
    id="order-1001",              # your business key
    task_queue="orders",          # the queue the worker polls
)
print("result:", await handle.result())` },
      { type: 'html', html: `
        <h2>Playground: scale and break things</h2>
        <p>Add a burst of workflows with no workers, then add workers. Kill one mid-task. Add a worker on the wrong queue.</p>` },
      { type: 'widget', name: 'workers' },
      { type: 'html', html: `
        <h2>Production notes</h2>
        <ul>
          <li><b>Scale horizontally</b>: run more identical worker processes. Tune <code>maxConcurrentActivityTaskExecutions</code> per worker.</li>
          <li><b>Separate task queues</b> for different hardware or isolation (e.g. a GPU queue for ML activities).</li>
          <li><b>Workers are stateless</b>: they can be killed, autoscaled, or redeployed at will; state lives in Event History.</li>
          <li>Workflow and activity workers can live in separate processes polling different queues.</li>
          <li>The worker only makes <b>outbound</b> connections, so no inbound firewall holes are needed.</li>
          <li><b>Every worker on a queue must register the same workflow and activity types</b>; a Worker Entity polls exactly one queue, and a task for a type it doesn’t know fails on that worker.</li>
        </ul>` },
      { type: 'quiz', questions: [
        { q: 'You started a workflow but nothing happens and the Web UI shows it “Running” with a pending workflow task. Most likely cause?', o: ['The workflow code has a syntax error', 'No worker is polling that task queue name', 'The Temporal Service is out of disk', 'Activities have no timeouts'], a: 1, why: 'Mismatched or missing workers mean tasks just sit in the queue.' },
        { q: 'A worker holding an activity task is killed. What happens to that task?', o: ['It is lost forever', 'It times out and is handed to another worker', 'The workflow fails immediately', 'The Temporal Service executes it'], a: 1, why: 'Timeouts (and heartbeats) detect the loss and the task is rescheduled.' },
      ] },
    ],
  },

  /* ------------------------------------------------------------------ 5 */
  {
    id: 'signals', icon: '📨', title: 'Signals', time: '8 min', blurb: 'Send data into a running workflow.',
    sections: [
      { type: 'html', html: `
        <p class="lead">A Signal is an asynchronous, durable message sent to a running workflow. It can change workflow state; the sender gets no result back.</p>
        <div class="analogy"><b>🎯 Analogy.</b> A sticky note placed on the project manager’s desk: “customer added an item”. Even if the manager is out, the note is there when they return.</div>
        <h2>Defining a handler</h2>` },
      { type: 'code', title: 'cart workflow with signals', ts: `import { defineSignal, setHandler, condition } from '@temporalio/workflow';

export const addItemSignal = defineSignal<[string]>('addItem');
export const checkoutSignal = defineSignal('checkout');

export async function cartWorkflow(): Promise<string[]> {
  const items: string[] = [];
  let checkedOut = false;

  setHandler(addItemSignal, (item) => { items.push(item); });
  setHandler(checkoutSignal, () => { checkedOut = true; });

  await condition(() => checkedOut);   // sleep until a signal flips the flag
  return items;
}

// client side
const handle = client.workflow.getHandle('cart-42');
await handle.signal(addItemSignal, 'book');`,
        py: `@workflow.defn
class CartWorkflow:
    def __init__(self) -> None:
        self.items: list[str] = []
        self.checked_out = False

    @workflow.run
    async def run(self) -> list[str]:
        await workflow.wait_condition(lambda: self.checked_out)
        return self.items

    @workflow.signal
    def add_item(self, item: str) -> None:
        self.items.append(item)

    @workflow.signal
    def checkout(self) -> None:
        self.checked_out = True

# client side
handle = client.get_workflow_handle("cart-42")
await handle.signal(CartWorkflow.add_item, "book")` },
      { type: 'html', html: `<h2>Lab</h2><p>Send some signals, then simulate an outage.</p>` },
      { type: 'widget', name: 'signalLab' },
      { type: 'html', html: `
        <div class="callout tip"><b class="t">Signal-with-start</b>Don’t know whether the workflow exists yet? <code>signalWithStart</code> atomically starts it if needed and then delivers the signal. Perfect for “create or append” flows.</div>
        <div class="callout warn"><b class="t">Gotchas</b><ul><li>Signals to a <b>closed</b> workflow fail.</li><li>A signal returns as soon as the server <b>accepts</b> it; it does not wait for your handler to run.</li><li>Handlers run inside the workflow, so they must be deterministic (no direct I/O). Keep them tiny: set state, then let the main workflow function react via <code>condition()</code>. Handlers <em>may</em> be async (e.g. to call an activity); if so, they interleave with other code at every <code>await</code>, so guard shared state with a lock and wait for them (<code>allHandlersFinished</code>) before the workflow returns.</li><li>Signals have no return value. Need a result or validation? Use an <b>Update</b> (module 7).</li><li>There is a limit of 10,000 signals per workflow execution (Temporal Cloud docs): long-lived workflows should Continue-As-New.</li></ul></div>` },
      { type: 'quiz', questions: [
        { q: 'You signal a workflow while its worker is offline. What happens to the signal?', o: ['It is dropped', 'The send call fails', 'It is recorded in history and handled when a worker returns', 'It is queued in the client SDK'], a: 2, why: 'Signals are persisted in Event History by the service, so they are never lost.' },
        { q: 'Which statement about signals is true?', o: ['They return the handler’s result', 'They can read state without side effects', 'They are asynchronous with no return value', 'They can be sent to completed workflows'], a: 2, why: 'Signals are fire-and-forget from the sender’s viewpoint.' },
      ] },
    ],
  },

  /* ------------------------------------------------------------------ 6 */
  {
    id: 'queries', icon: '🔍', title: 'Queries', time: '7 min', blurb: 'Read workflow state, safely.',
    sections: [
      { type: 'html', html: `
        <p class="lead">A Query synchronously reads the current state of a workflow. It must not change anything, so it adds nothing to Event History.</p>
        <div class="analogy"><b>🎯 Analogy.</b> Peeking at the manager’s whiteboard. You see the current plan; you cannot write on it, and your peek leaves no trace.</div>
        <h2>Defining a query</h2>` },
      { type: 'code', title: 'adding a query', ts: `import { defineQuery, setHandler } from '@temporalio/workflow';

export const getItemsQuery = defineQuery<string[]>('getItems');

export async function cartWorkflow() {
  const items: string[] = [];
  setHandler(getItemsQuery, () => items);   // read-only, synchronous, no awaits
  // ...
}

// client side
const items = await handle.query(getItemsQuery);`,
        py: `@workflow.query
def get_items(self) -> list[str]:
    return self.items            # read-only, synchronous, not async

# client side
items = await handle.query(CartWorkflow.get_items)` },
      { type: 'html', html: `<h2>Lab</h2><p>Notice that history length never changes when you query. Then try the edge cases.</p>` },
      { type: 'widget', name: 'queryLab' },
      { type: 'html', html: `
        <div class="callout key"><b class="t">Rules of queries</b><ul>
          <li>Handlers are <b>read-only</b> and <b>synchronous</b> (not <code>async</code>): they must not call activities or mutate state.</li>
          <li>Queries <b>always need a worker</b>: it holds (or replays history to rebuild) the state the handler reads. With no worker you get <code>FAILED_PRECONDITION</code> (“no poller seen for task queue recently”) or a timeout.</li>
          <li>They also work on <b>completed, failed and timed-out</b> workflows (within the retention period), handy for “what was the final state?”. <b>Terminated</b> workflows can’t be queried.</li>
          <li>A query handler that throws gives the <em>caller</em> an error (Python <code>WorkflowQueryFailedError</code>; in TypeScript a <code>QueryNotRegisteredError</code>); it does <b>not</b> fail the workflow.</li>
          <li>Every workflow answers the built-in queries <code>__stack_trace</code> (CLI: <code>temporal workflow stack</code>), <code>__enhanced_stack_trace</code> and <code>__temporal_workflow_metadata</code>.</li>
          <li>A query sent right after a signal is not guaranteed to see its effect: poll, or use an Update.</li>
        </ul></div>
        <div class="callout warn"><b class="t">Don’t build dashboards that hammer queries</b>A worker answers from its in-memory cache; if the workflow isn’t cached it must replay history first, which adds latency (more so for long histories). Put a short cache in front of busy dashboards, and for “list all orders” screens use Temporal’s visibility features rather than querying every workflow.</div>` },
      { type: 'quiz', questions: [
        { q: 'How many events does a successful query add to Event History?', o: ['One', 'Two', 'None', 'It depends on the result size'], a: 2, why: 'Queries are read-only and leave no trace in history.' },
        { q: 'Can a query handler start an activity to fetch fresh data?', o: ['Yes, if it awaits', 'Yes, with a flag', 'No, handlers must be synchronous and side-effect free', 'Only in Python'], a: 2, why: 'Query handlers cannot do anything asynchronous or mutate state.' },
      ] },
    ],
  },

  /* ------------------------------------------------------------------ 7 */
  {
    id: 'updates', icon: '✅', title: 'Updates', time: '9 min', blurb: 'Validated, tracked requests with a response.',
    sections: [
      { type: 'html', html: `
        <p class="lead">An Update is a request that <b>can change workflow state and returns a result</b> to the caller. It can be validated and rejected before it ever touches history.</p>
        <div class="analogy"><b>🎯 Analogy.</b> A change request with a receipt. You hand it over, the manager checks it against the rules, and you walk away with either “accepted, here’s the new total” or “rejected, here’s why”.</div>
        <h2>Defining an update with a validator</h2>` },
      { type: 'code', title: 'update + validator', ts: `import { defineUpdate, setHandler } from '@temporalio/workflow';

export const addItemUpdate = defineUpdate<number, [string]>('addItemUpdate');

setHandler(
  addItemUpdate,
  (item) => { items.push(item); return items.length; },     // handler: may mutate + return
  { validator: (item) => {                                   // runs first; throw to reject
      if (!item) throw new Error('item must not be empty');
      if (items.includes(item)) throw new Error('duplicate item');
      if (items.length >= 3) throw new Error('cart is full');
  } },
);

// client side: blocks until the handler returns (or the validator rejects)
const count = await handle.executeUpdate(addItemUpdate, { args: ['pen'] });`,
        py: `@workflow.update
def add_item_update(self, item: str) -> int:
    self.items.append(item)
    return len(self.items)

@add_item_update.validator
def validate_add_item(self, item: str) -> None:
    if not item:
        raise ValueError("item must not be empty")
    if item in self.items:
        raise ValueError("duplicate item")
    if len(self.items) >= 3:
        raise ValueError("cart is full")

# client side: blocks until the handler returns (or the validator rejects)
count = await handle.execute_update(CartWorkflow.add_item_update, "pen")` },
      { type: 'html', html: `<h2>Lab</h2><p>Add items until the validator rejects one. Compare the event history with the signal lab.</p>` },
      { type: 'widget', name: 'updateLab' },
      { type: 'html', html: `
        <h2>Signal vs Query vs Update</h2>
        <table>
          <tr><th></th><th>Signal</th><th>Query</th><th>Update</th></tr>
          <tr><td>Changes state?</td><td>✅ yes</td><td>❌ never</td><td>✅ yes</td></tr>
          <tr><td>Returns a value?</td><td>❌</td><td>✅</td><td>✅</td></tr>
          <tr><td>Synchronous for caller?</td><td>No (fire &amp; forget)</td><td>Yes</td><td>Yes (or async via “accepted” stage)</td></tr>
          <tr><td>Can be rejected by validator?</td><td>❌</td><td>n/a</td><td>✅ (not recorded in history)</td></tr>
          <tr><td>Written to history?</td><td>✅ always</td><td>❌ never</td><td>✅ only if accepted</td></tr>
          <tr><td>Handler may call activities / await?</td><td>✅ (async handler)</td><td>❌</td><td>✅ (async handler)</td></tr>
          <tr><td>Typical use</td><td>“customer cancelled”</td><td>“what’s the status?”</td><td>“change address and tell me if OK”</td></tr>
        </table>
        <div class="callout tip"><b class="t">Rule of thumb</b>Need an answer or validation? <b>Update</b>. Just reading? <b>Query</b>. Just notifying, no response needed? <b>Signal</b>.</div>
        <div class="callout warn"><b class="t">Good to know</b><ul>
          <li><b>Fail updates with ApplicationError / ApplicationFailure.</b> A plain exception inside an update <em>handler</em> doesn’t fail the update: it fails the workflow task, which retries, so the caller just waits. (Validators may throw anything.)</li>
          <li><b>Update IDs</b> are idempotency keys: two updates with the same ID to the same run return the first one’s result.</li>
          <li>Limits (Temporal Cloud docs): 10 in-flight updates and 2,000 total per workflow run.</li>
          <li>You can wait only until an update is accepted (<code>startUpdate</code> / <code>start_update</code> with <code>ACCEPTED</code>) and fetch the result later.</li>
          <li><b>Update-With-Start</b> starts a workflow if needed and sends the update in one call, but unlike Signal-With-Start it is <em>not atomic</em>.</li>
        </ul></div>` },
      { type: 'quiz', questions: [
        { q: 'A validator rejects an update. What is written to Event History?', o: ['An UpdateRejected event', 'A failed workflow task', 'Nothing', 'A signal event'], a: 2, why: 'Rejected updates leave no trace in history, which keeps histories small.' },
        { q: 'You need to cancel an order and tell the caller whether the cancellation was permitted. Best primitive?', o: ['Signal', 'Query', 'Update', 'Schedule'], a: 2, why: 'Updates can mutate state and return a result or a validation error.' },
        { q: 'You want the support dashboard to display the order status. Best primitive?', o: ['Signal', 'Query', 'Update', 'Activity'], a: 1, why: 'Read-only retrieval is exactly what Queries are for.' },
      ] },
    ],
  },

  /* ------------------------------------------------------------------ 8 */
  {
    id: 'schedules', icon: '⏰', title: 'Schedules', time: '10 min', blurb: 'Cron on steroids.',
    sections: [
      { type: 'html', html: `
        <p class="lead">A Schedule starts a workflow on a recurring basis (intervals, calendar specs, or cron expressions). Unlike plain cron, a schedule is a first-class, observable object you can pause, edit, trigger, and backfill.</p>
        <div class="analogy"><b>🎯 Analogy.</b> An alarm clock that starts a new project each time it rings, and that you can snooze, edit, or ring on demand.</div>
        <h2>Creating a schedule</h2>` },
      { type: 'code', title: 'schedule lifecycle', ts: `import { Client, ScheduleOverlapPolicy } from '@temporalio/client';

const client = new Client();
const schedule = await client.schedule.create({
  scheduleId: 'weekday-report',
  spec: { cronExpressions: ['0 9 * * MON-FRI'], timezone: 'Europe/Berlin' },
  policies: { overlap: ScheduleOverlapPolicy.SKIP },
  action: { type: 'startWorkflow', workflowType: 'reportWorkflow', taskQueue: 'reports', args: [] },
});

await schedule.pause('maintenance window');   // stop firing
await schedule.unpause();
await schedule.trigger(ScheduleOverlapPolicy.SKIP); // run it right now. Pass the policy: a bare trigger() means ALLOW_ALL in TS
await schedule.backfill([{ start: new Date('2026-01-01'), end: new Date('2026-01-08'),
                           overlap: ScheduleOverlapPolicy.ALLOW_ALL }]);
await schedule.delete();`,
        py: `from temporalio.client import (
    Client, Schedule, ScheduleActionStartWorkflow, ScheduleSpec,
    ScheduleCalendarSpec, SchedulePolicy, ScheduleOverlapPolicy, ScheduleRange)

client = await Client.connect("localhost:7233")
handle = await client.create_schedule(
    "weekday-report",
    Schedule(
        action=ScheduleActionStartWorkflow(
            ReportWorkflow.run, id="report", task_queue="reports"),
        spec=ScheduleSpec(
            calendars=[ScheduleCalendarSpec(
                hour=[ScheduleRange(9)],
                day_of_week=[ScheduleRange(1, 5)])]),
        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy.SKIP),
    ),
)
await handle.pause(note="maintenance window")
await handle.unpause()
await handle.trigger()
await handle.delete()` },
      { type: 'html', html: `
        <h2>Overlap policies: the interesting part</h2>
        <p>What if a run is still going when the next tick arrives? That is decided by the <b>overlap policy</b>. Try each one, and also pause the schedule mid-way.</p>` },
      { type: 'widget', name: 'schedule' },
      { type: 'html', html: `
        <table><tr><th>Policy</th><th>Behaviour</th><th>Good for</th></tr>
        <tr><td>SKIP <small>(default)</small></td><td>Drop the new tick</td><td>Idempotent jobs where the next run catches up</td></tr>
        <tr><td>BUFFER_ONE</td><td>Keep at most one waiting</td><td>“Run again after this one”, no pile-up</td></tr>
        <tr><td>BUFFER_ALL</td><td>Queue every missed tick</td><td>Every tick must be processed (beware backlog)</td></tr>
        <tr><td>CANCEL_OTHER</td><td>Gracefully cancel the old run, start new</td><td>Only the latest data matters</td></tr>
        <tr><td>TERMINATE_OTHER</td><td>Kill the old run, start new</td><td>Same, but the old run can’t clean up</td></tr>
        <tr><td>ALLOW_ALL</td><td>Run concurrently</td><td>Independent runs</td></tr></table>
        <div class="callout tip"><b class="t">Other schedule features</b><ul>
          <li><b>Catchup window</b>: how far back to run missed actions after downtime.</li>
          <li><b>Jitter</b>: randomise start to avoid thundering herds.</li>
          <li><b>Calendars, intervals, cron</b> can be combined; use <code>skip</code> (exclusion calendars) for holidays.</li>
          <li><b>Pause / limited actions</b>: stop automatically after N fires.</li>
        </ul></div>
        <div class="callout key"><b class="t">Schedules vs cronSchedule on a workflow</b>Prefer Schedules. The older “cron workflow” option is legacy: Schedules are editable, observable, pausable, and support backfill and overlap policies.</div>` },
      { type: 'quiz', questions: [
        { q: 'A nightly job sometimes runs over 24h. If it is still running at the next tick you want the new tick dropped. Which policy?', o: ['ALLOW_ALL', 'SKIP', 'TERMINATE_OTHER', 'BUFFER_ALL'], a: 1, why: 'SKIP drops ticks while a run is active.' },
        { q: 'You need to run the schedule’s workflow right now, outside its normal timing. Which operation?', o: ['backfill', 'trigger', 'update spec', 'delete and recreate'], a: 1, why: 'trigger fires an immediate action using the schedule’s configuration. In TypeScript pass the overlap policy explicitly: a bare trigger() overrides it with ALLOW_ALL.' },
        { q: 'Why choose a Schedule over a cron job on a server?', o: ['It is lighter weight', 'It is durable, observable, pausable and has overlap policies', 'It doesn’t require workers', 'It avoids workflows entirely'], a: 1, why: 'Schedules are first-class Temporal objects with rich controls.' },
      ] },
    ],
  },

  /* ------------------------------------------------------------------ 9 */
  {
    id: 'patterns', icon: '🧩', title: 'Patterns', time: '20 min', blurb: 'Saga, approvals, fan-out, entity workflows.',
    sections: [
      { type: 'html', html: `
        <p class="lead">With the primitives in hand you can assemble the classic distributed-systems patterns, as plain code.</p>
        <h2>Pattern 1: Saga (compensations)</h2>
        <p>No distributed transaction exists across a flight, hotel and car service. Instead, each step registers an <b>undo</b>. If a later step fails, run the undos in reverse order.</p>` },
      { type: 'code', title: 'saga', ts: `export async function bookTripWorkflow(trip: Trip): Promise<void> {
  const compensations: Array<() => Promise<void>> = [];
  try {
    await bookFlight(trip);
    compensations.unshift(() => cancelFlight(trip));   // unshift => reverse order later
    await bookHotel(trip);
    compensations.unshift(() => cancelHotel(trip));
    await bookCar(trip);
  } catch (err) {
    for (const undo of compensations) {
      await undo();                                     // compensations must be idempotent
    }
    throw err;
  }
}`,
        py: `@workflow.defn
class BookTripWorkflow:
    @workflow.run
    async def run(self, trip: Trip) -> None:
        opts = dict(start_to_close_timeout=timedelta(seconds=30))
        compensations = []
        try:
            await workflow.execute_activity(book_flight, trip, **opts)
            compensations.append(cancel_flight)
            await workflow.execute_activity(book_hotel, trip, **opts)
            compensations.append(cancel_hotel)
            await workflow.execute_activity(book_car, trip, **opts)
        except Exception:
            for undo in reversed(compensations):
                await workflow.execute_activity(undo, trip, **opts)
            raise` },
      { type: 'widget', name: 'saga' },
      { type: 'html', html: `
        <h2>Pattern 2: Human-in-the-loop approval</h2>
        <p>Wait for a signal <em>or</em> a timeout, whichever comes first. The workflow can wait weeks at zero cost.</p>` },
      { type: 'code', title: 'approval with timeout', ts: `const approveSignal = defineSignal<[boolean]>('approve');

export async function expenseWorkflow(amount: number): Promise<string> {
  let decision: boolean | undefined;
  setHandler(approveSignal, (ok) => { decision = ok; });

  await notifyManager(amount);
  // condition(fn, timeout) resolves true if fn became true, false on timeout
  const decided = await condition(() => decision !== undefined, '24 hours');
  if (!decided) {
    await escalateToDirector(amount);
    return 'escalated';
  }
  return decision ? 'approved' : 'rejected';
}`,
        py: `@workflow.defn
class ExpenseWorkflow:
    def __init__(self) -> None:
        self.decision: bool | None = None

    @workflow.signal
    def approve(self, ok: bool) -> None:
        self.decision = ok

    @workflow.run
    async def run(self, amount: int) -> str:
        await workflow.execute_activity(notify_manager, amount,
            start_to_close_timeout=timedelta(seconds=30))
        try:
            await workflow.wait_condition(
                lambda: self.decision is not None, timeout=timedelta(hours=24))
        except asyncio.TimeoutError:
            await workflow.execute_activity(escalate_to_director, amount,
                start_to_close_timeout=timedelta(seconds=30))
            return "escalated"
        return "approved" if self.decision else "rejected"` },
      { type: 'widget', name: 'approval' },
      { type: 'html', html: `
        <h2>Pattern 3: Fan-out / fan-in</h2>
        <p>Process many items in parallel, then aggregate. For modest counts use parallel activities; for large or long-lived pieces use <b>child workflows</b>, which have their own history and failure isolation.</p>` },
      { type: 'code', title: 'fan-out / fan-in', ts: `import { executeChild } from '@temporalio/workflow';

export async function processBatchWorkflow(orderIds: string[]): Promise<number> {
  // parallel activities (small, quick work)
  await Promise.all(orderIds.map((id) => sendReceipt(id)));

  // child workflows (large or long-running work, each with its own history)
  const results = await Promise.all(
    orderIds.map((id) => executeChild(orderWorkflow, { args: [id], workflowId: 'order-' + id })),
  );
  return results.length;
}`,
        py: `@workflow.defn
class ProcessBatchWorkflow:
    @workflow.run
    async def run(self, order_ids: list[str]) -> int:
        # parallel activities (small, quick work)
        await asyncio.gather(*[
            workflow.execute_activity(send_receipt, oid,
                start_to_close_timeout=timedelta(seconds=30))
            for oid in order_ids])

        # child workflows (large or long-running work)
        results = await asyncio.gather(*[
            workflow.execute_child_workflow(OrderWorkflow.run, oid, id="order-" + oid)
            for oid in order_ids])
        return len(results)` },
      { type: 'html', html: `
        <div class="callout warn"><b class="t">Limit the fan-out</b>One workflow history is capped (~50K events / 50MB). Batch big jobs (e.g. 100 children at a time) or use child workflows that themselves fan out.</div>
        <h2>Pattern 4: Entity workflow + Continue-As-New</h2>
        <p>Model a long-lived thing (a customer, a device, a shopping cart) as one workflow that lives for months and reacts to signals/updates. To keep history from growing forever, periodically <b>Continue-As-New</b>: finish this run and start a fresh one with the current state.</p>` },
      { type: 'code', title: 'entity workflow', ts: `import { continueAsNew, workflowInfo, condition, setHandler, defineSignal } from '@temporalio/workflow';

export async function customerWorkflow(state: CustomerState): Promise<void> {
  const inbox: Event[] = [];
  setHandler(eventSignal, (e) => { inbox.push(e); });

  while (true) {
    await condition(() => inbox.length > 0);
    const e = inbox.shift()!;
    state = await applyEvent(state, e);          // activity or pure logic

    if (workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof customerWorkflow>(state);  // fresh history, same Workflow ID
    }
  }
}`,
        py: `@workflow.defn
class CustomerWorkflow:
    def __init__(self) -> None:
        self.inbox: list[dict] = []

    @workflow.signal
    def event(self, e: dict) -> None:
        self.inbox.append(e)

    @workflow.run
    async def run(self, state: dict) -> None:
        while True:
            await workflow.wait_condition(lambda: len(self.inbox) > 0)
            e = self.inbox.pop(0)
            state = await workflow.execute_activity(apply_event, args=[state, e],
                start_to_close_timeout=timedelta(seconds=30))
            if workflow.info().is_continue_as_new_suggested():
                workflow.continue_as_new(state)   # fresh history, same Workflow ID` },
      { type: 'html', html: `
        <h2>Pattern checklist</h2>
        <table><tr><th>You need…</th><th>Reach for…</th></tr>
          <tr><td>All-or-nothing across services</td><td>Saga with compensations</td></tr>
          <tr><td>A person must decide</td><td>Signal/Update + timer via <code>condition(fn, timeout)</code></td></tr>
          <tr><td>Process N things in parallel</td><td>Parallel activities or child workflows</td></tr>
          <tr><td>Long-lived stateful object</td><td>Entity workflow + Continue-As-New</td></tr>
          <tr><td>Wait for an external system</td><td>Prefer a signal/callback; otherwise an activity with retries (or heartbeats), not a tight polling loop</td></tr>
          <tr><td>Recurring job</td><td>Schedule</td></tr>
          <tr><td>Exactly-once effects</td><td>Idempotent activities, keyed by workflow ID + activity ID</td></tr></table>` },
      { type: 'quiz', questions: [
        { q: 'In a saga, in which order should compensations run?', o: ['Same order as the steps', 'Reverse order of the completed steps', 'Random', 'Only the failed step is compensated'], a: 1, why: 'You unwind like a stack: last completed step is undone first.' },
        { q: 'A customer workflow must live for years. What stops its history from growing without bound?', o: ['Deleting old events manually', 'Continue-As-New', 'Increasing the retention period', 'Using queries'], a: 1, why: 'Continue-As-New closes the run and starts a new one with the carried state.' },
        { q: 'You wait for manager approval for up to 3 days, then escalate. Which combination is idiomatic?', o: ['Activity that polls a DB every minute', 'Signal handler + condition() with a timeout', 'cron schedule', 'Query loop'], a: 1, why: 'Wait on a signal-driven flag with a timeout. No polling, zero cost.' },
      ] },
    ],
  },

  /* ------------------------------------------------------------------ 10 */
  {
    id: 'boss', icon: '👑', title: 'Final Challenge', time: '8 min', blurb: 'Prove it, then take the cheat sheet.',
    sections: [
      { type: 'html', html: `
        <p class="lead">Time to combine everything. Eight scenarios; pick the primitive that fits. Score 7 or more to earn the crown.</p>` },
      { type: 'widget', name: 'boss' },
      { type: 'html', html: `
        <h2>Cheat sheet</h2>
        <table>
          <tr><th>Primitive</th><th>One-liner</th><th>Remember</th></tr>
          <tr><td>🧠 Workflow</td><td>Durable, deterministic orchestration</td><td>Decides, never does I/O</td></tr>
          <tr><td>⚙️ Activity</td><td>One failure-prone side effect</td><td>At-least-once → idempotent; set timeouts &amp; retry policy</td></tr>
          <tr><td>🧑‍🏭 Worker</td><td>Process polling a task queue</td><td>Stateless, scale out; queue names must match</td></tr>
          <tr><td>📨 Signal</td><td>Async message in</td><td>No return value, durable</td></tr>
          <tr><td>🔍 Query</td><td>Sync read of state</td><td>Read-only, no history, needs a worker</td></tr>
          <tr><td>✅ Update</td><td>Validated sync change with result</td><td>Rejected updates leave no history</td></tr>
          <tr><td>⏰ Schedule</td><td>Recurring starts</td><td>Overlap policy, pause, trigger, backfill</td></tr>
        </table>
        <h2>Where to go next</h2>
        <ul>
          <li>Build the order workflow locally with <code>temporal server start-dev</code> and watch it in the Web UI (<code>localhost:8233</code>).</li>
          <li>Write a <b>replay test</b> for your workflows so deployments never break running executions.</li>
          <li>Learn <b>Search Attributes</b> (find workflows by business fields), <b>Nexus</b> (cross-team calls), and <b>Worker Versioning</b> (safe deploys).</li>
          <li>Official docs: <a href="https://docs.temporal.io" target="_blank" rel="noopener">docs.temporal.io</a> and free courses at <a href="https://learn.temporal.io" target="_blank" rel="noopener">learn.temporal.io</a>.</li>
        </ul>` },
      { type: 'quiz', questions: [
        { q: 'Which of these must NOT appear directly in workflow code?', o: ['A loop over items', 'sleep("1 day")', 'A direct HTTP call to a payment API', 'A call to an activity'], a: 2, why: 'I/O belongs in Activities.' },
        { q: 'Which message type is recorded in history even if the workflow ignores it, and never returns data?', o: ['Query', 'Signal', 'Update', 'Heartbeat'], a: 1, why: 'Signals are always recorded and are fire-and-forget.' },
      ] },
    ],
  },
];
