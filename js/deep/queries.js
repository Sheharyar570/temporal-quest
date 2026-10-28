'use strict';

/*
 * Deep dive: Queries.
 * Facts come from docs.temporal.io, the CLI docs and the SDK type definitions (see `sources`); behaviour that
 * the pages don't state was checked by running it. Every use case's code is the file in examples/queries/*
 * that passed its tests (Python 1.34.0, TypeScript 1.24.0, 2026-10-27).
 */
DEEP.queries = {
  title: 'Queries in depth',
  badge: 'deepQueries',
  verified: 'Verified 2026-10-27 · temporalio Python 1.34.0 · @temporalio/* TypeScript 1.24.0 · every scenario passes in both languages against a local Temporal dev server (CLI 1.9.1, server 1.32.0); CLI commands run against the same server',

  under: `
    <h2>Under the hood</h2>
    <h3>What a query is, and what it is not</h3>
    <p>A Query is a <b>synchronous, read-only request</b> for the current state of a workflow. A worker runs your query handler against the workflow’s state and returns the result. It <b>never adds an event to Event History</b>: we counted the events before and after 20 queries, and before and after a whole polled import, and the numbers were identical.</p>
    <table>
      <tr><th></th><th>Query</th><th>Why it matters</th></tr>
      <tr><td>Changes state?</td><td>Never</td><td>Handlers must not mutate workflow state. If a query had side effects, replay would diverge.</td></tr>
      <tr><td>Async / activities?</td><td>No</td><td>Handlers are plain synchronous functions: <code>def</code> in Python (not <code>async def</code>), a non-async function in TypeScript.</td></tr>
      <tr><td>Arguments &amp; result?</td><td>Yes / yes</td><td>Both are typed; use dataclasses / interfaces.</td></tr>
      <tr><td>Needs a worker?</td><td><b>Yes, always</b></td><td>The worker holds (or rebuilds by replay) the state the handler reads.</td></tr>
      <tr><td>Open workflows?</td><td>Yes</td><td></td></tr>
      <tr><td>Closed workflows?</td><td>Completed / failed / timed out: yes, within the namespace retention period. <b>Terminated: not supported.</b></td><td>Handy for “what was the final state?” pages.</td></tr>
    </table>

    <h3>What the client sees when things go wrong</h3>
    <table>
      <tr><th>Situation</th><th>Python</th><th>TypeScript</th></tr>
      <tr><td>Your handler throws</td><td><code>WorkflowQueryFailedError</code></td><td><code>QueryNotRegisteredError</code> (a confusing name for this case; the message carries your text)</td></tr>
      <tr><td>Unknown query name</td><td><code>WorkflowQueryFailedError</code> listing the known queries</td><td><code>QueryNotRegisteredError</code> listing the registered queries</td></tr>
      <tr><td>No worker polling the task queue</td><td><code>RPCError</code> with status <code>FAILED_PRECONDITION</code>: “no poller seen for task queue recently, worker may be down”</td><td><code>ServiceError</code> whose cause has gRPC code 9 (<code>FAILED_PRECONDITION</code>)</td></tr>
      <tr><td>Query rejected by your reject condition</td><td><code>WorkflowQueryRejectedError</code> (has <code>.status</code>)</td><td><code>QueryRejectedError</code> (has <code>.status</code>)</td></tr>
    </table>
    <div class="callout key"><b class="t">A failing query is harmless to the workflow</b>Unlike a failing signal or update handler, a query handler error does <b>not</b> fail a workflow task. We checked: after a handler error and an unknown-query error the workflow was still <code>RUNNING</code>. (The docs add one caution: a handler that blocks the thread for too long without yielding <em>can</em> cause a workflow task failure. Keep handlers instant.)</div>
    <p>In our runs an open workflow on a task queue that <em>never</em> had a poller returned “query timed out before a worker could process it” (a deadline error) instead; so treat both “no poller” and “timeout” as “the worker side is unavailable”.</p>

    <h3>Reject conditions</h3>
    <p>By default closed workflows can be queried. To say “only answer while the workflow is open”, set a reject condition:</p>
    <ul>
      <li><b>Python:</b> <code>handle.query(..., reject_condition=QueryRejectCondition.NOT_OPEN)</code> (per call, from <code>temporalio.common</code>).</li>
      <li><b>TypeScript:</b> a <b>client</b> option: <code>new Client({ workflow: { queryRejectCondition: 'NOT_OPEN' } })</code>, not a per-call argument.</li>
      <li><b>CLI:</b> <code>temporal workflow query --name status -w ID --reject-condition not_open</code>. Accepted values: <code>not_open</code>, <code>not_completed_cleanly</code>.</li>
    </ul>
    <p>We exercised <code>NOT_OPEN</code>: querying a completed workflow was rejected with status <code>COMPLETED</code> (CLI: “query was rejected, workflow has status: Completed”). <code>NOT_COMPLETED_CLEANLY</code> is a stricter variant that we did not exercise.</p>

    <h3>Consistency: don’t assume read-your-writes</h3>
    <p>A signal returns as soon as the server accepts it, not when your handler has run, and the Temporal docs don’t promise that a query sent right after a signal sees its effect. Community answers say it normally does, but that is not a guarantee, particularly if the signal handler awaits. In every test below we therefore <b>poll</b> after signalling. The docs’ guidance: for “asynchronous write, then read”, send a Signal and poll with a Query; if you need a write <em>and</em> its result back reliably, use an <b>Update</b>.</p>

    <h3>Performance</h3>
    <ul>
      <li>Queries cost nothing in history, so they are the efficient way to read. (The docs note that an Update-based read has better latency/efficiency in some cases but writes a history entry.)</li>
      <li>A worker answers from its in-memory (“sticky”) cache. If the workflow isn’t cached (worker restarted, cache evicted, stickiness lost) the worker must <b>replay history</b> first, which adds latency, and very long histories make that slower. A larger worker cache reduces replays.</li>
      <li>Keep handlers O(1) and results small. Cloud documents a 2 MB single-payload limit.</li>
      <li>Timestamps inside handlers are <b>workflow time</b> (<code>workflow.now()</code> / <code>Date</code>), never the wall clock, so they are only as fresh as the last time the workflow ran.</li>
      <li>For “list / filter all orders” screens across many workflows use Temporal’s visibility features, not a fan-out of queries. (General guidance; not exercised here.)</li>
    </ul>

    <h3>Built-in queries and the CLI</h3>
    <p>Every workflow answers three built-in queries, in both SDKs (we called each):</p>
    <table>
      <tr><th>Query</th><th>Returns</th></tr>
      <tr><td><code>__stack_trace</code></td><td>Where the workflow is currently blocked. <code>temporal workflow stack -w ID</code> runs exactly this query.</td></tr>
      <tr><td><code>__enhanced_stack_trace</code></td><td>The same, annotated with SDK name/version, file locations and sources.</td></tr>
      <tr><td><code>__temporal_workflow_metadata</code></td><td>The workflow type, every query/signal handler with its <code>description</code>, plus the “current details” text you set with <code>set_current_details</code> / <code>setCurrentDetails</code>.</td></tr>
    </table>
    <p>Send any query from the CLI with <code>temporal workflow query --name &lt;query&gt; -w &lt;workflowId&gt; [--input '&lt;json&gt;']</code> (note: <code>--name</code>; the docs’ example says <code>--type</code> but its own flag table says <code>--name</code>, and <code>--name</code> is what we ran).</p>`,

  cases: [
    /* -------------------------------------------------------------- 1 */
    {
      key: 'tracking', level: 'Medium', title: 'Order tracking API: the status endpoint behind “Where is my order?”',
      scenario: 'Customers and support agents open a tracking page that shows the stage of an order (packed, shipped, delivered), when it last changed, and the details of a single line item. The page is read thousands of times; the workflow only changes when the warehouse pushes an update.',
      why: 'The workflow already <em>is</em> the source of truth for the order’s state, so a query answers directly, with no extra table to keep in sync and no history written for every page view.',
      design: [
        'One workflow per order. Warehouse and carrier systems send an <code>advance</code> <b>signal</b>; the workflow moves through <code>received → packed → shipped → delivered</code>.',
        'Two queries: <code>status</code> (no arguments, returns a typed snapshot) and <code>item</code> (takes a SKU, returns that line).',
        'Timestamps come from the workflow clock (<code>workflow.now()</code> / <code>Date</code>), never the wall clock.',
        'The API layer maps errors: query-failed → 404/400 with the message; “no worker / timeout” → 503 and retry.',
        'Closed orders are still answerable: the tracking page can show the final state after delivery.',
      ],
      tested: [
        '<code>status</code> returns the initial stage; <code>item</code> works with an argument.',
        'A handler that throws, and a query name that doesn’t exist, both produce a client-side query error, and the workflow is still <code>RUNNING</code> afterwards.',
        '20 consecutive queries leave the Event History event count <b>unchanged</b>.',
        'After sending <code>advance</code>, the new stage becomes visible by <b>polling</b>; the test deliberately does not assume it is visible immediately.',
        'After completion the final status is still queryable; with a <code>NOT_OPEN</code> reject condition the same query is rejected with status <code>COMPLETED</code>.',
        'With the worker stopped, even the completed workflow can’t be queried: <code>FAILED_PRECONDITION</code> (“no poller seen for task queue recently”).',
      ],
      pitfalls: [
        'Don’t mutate anything in a handler, not even “last viewed at” or a counter. Handlers must be read-only or replay breaks.',
        'No <code>await</code>, no activity calls, and in Python <code>def</code> not <code>async def</code>. Need fresh data from outside? Have the workflow fetch it in the main flow and store it in state.',
        'Return copies of mutable state (<code>list(self.steps_done)</code>) so the caller can’t observe later mutation.',
        'In TypeScript a thrown handler error surfaces as <code>QueryNotRegisteredError</code>; tell “bad input” from “unknown query” by the message, or return a result object with an <code>error</code> field for expected cases.',
        'A signal followed immediately by a query may not show the change yet. If the UI must show the result of an action, make that action an Update that returns the new state.',
      ],
      variations: ['Add a <code>history</code> query returning the last N transitions (bounded).', 'Expose the current ETA, calculated in the workflow when the stage changes.', 'Replace the signal with an Update so the warehouse system gets an acknowledgement.'],
    },
    /* -------------------------------------------------------------- 2 */
    {
      key: 'progress', level: 'Hard', title: 'Live progress for a long-running import, polled by many dashboards',
      scenario: 'A data-import workflow processes a million records in chunks over an hour. The operations dashboard, the customer’s progress bar and an alerting bot all poll it, each every few seconds. They need counts, percent, the most recent errors and an ETA, without slowing the import or bloating history.',
      why: 'Progress is a perfect fit for a query: it’s current-state, read-heavy and disposable. Polling costs no history, so a hundred observers don’t change what the workflow records.',
      design: [
        'The workflow keeps <b>incremental counters</b> (<code>done</code>, <code>failed</code>, <code>chunks_done</code>) updated after each chunk-activity, plus a <b>bounded</b> list of the last 5 errors.',
        'The <code>progress</code> query only <em>reads</em> those fields and does a little arithmetic (percent, elapsed from the workflow clock, ETA). It’s O(1) no matter how big the import is.',
        'A <code>finished</code> flag tells pollers to stop. After completion the same query returns the final snapshot.',
        'Chunking (100 records per activity here) bounds history growth as well; for very large imports combine with Continue-As-New or child workflows.',
        'Put a small cache (1–2 s) in the API tier in front of the query so a hundred viewers cost one query per interval. (Design advice; not part of the tests.)',
      ],
      tested: [
        'While 1,000 records import, repeated polling observes <b>intermediate</b> progress (not just 0 and 100%) and the processed count <b>never goes backwards</b>.',
        'Final snapshot: 972 done, 28 failed, 100.0%, 10 chunks, and exactly <b>5</b> recent errors with the latest being record 999 (bounded).',
        'An ETA is available while the import is running.',
        '<b>Polling adds nothing to history:</b> a run polled ~dozens of times and a run never polled produced the <b>same number of history events</b>.',
      ],
      pitfalls: [
        'Don’t compute progress by walking a big list in the handler (<code>sum(...)</code> over a million items). Maintain counters as you go.',
        'Bound everything you return. An unbounded “all errors so far” list will eventually exceed payload limits and slow every poll.',
        'Elapsed time and ETA use workflow time. They’re accurate as of the last time the workflow ran, so show them as estimates.',
        'Include a <code>finished</code> flag (or status) so clients can stop polling rather than polling forever.',
        'Queries are served from the worker’s cache; if the worker restarts mid-import the first query replays history. This is normal, but it is why you shouldn’t poll at millisecond rates.',
        'When the viewers need push rather than poll, send updates out of an <em>activity</em> (webhook/websocket) in addition to the query.',
      ],
      variations: ['Per-chunk status for the last 10 chunks (bounded ring buffer).', 'A <code>pause</code> signal and a <code>paused</code> field in the snapshot.', 'Several import workflows summarised by a parent via child-workflow results rather than by fanning out queries.'],
    },
    /* -------------------------------------------------------------- 3 */
    {
      key: 'diagnostics', level: 'Hard', title: 'Operability: diagnosing a stuck workflow with a diagnostics query and built-in queries',
      scenario: 'It’s 2 a.m. A shipment workflow hasn’t finished in six hours. On-call needs to know, in seconds and without reading code, which stage it is in, exactly what it’s waiting for, how long it has been there, and whether its history is getting large.',
      why: 'A workflow’s state is the best description of what it is doing, and it already lives in memory. A purpose-built <code>diagnostics</code> query plus Temporal’s built-in queries turn “why is it stuck?” into one command.',
      design: [
        'A private helper (<code>_enter</code> / <code>enter</code>) is the <b>only</b> way to change stage. It records <code>stage</code>, <code>waiting_on</code> (a human-readable cause such as “signal: carrier_confirmed”), the transition time, and calls <code>set_current_details</code> so the Web UI shows a sentence next to the workflow.',
        'The <code>diagnostics</code> query returns that snapshot plus <code>history_length</code> and <code>continue_as_new_suggested</code> from the workflow info, so on-call can tell “stuck” from “getting too big”.',
        'Handlers carry <b>descriptions</b> (<code>description=...</code>), which are published through the metadata query.',
        'Runbook: <code>temporal workflow query --name diagnostics -w ID</code>, then <code>temporal workflow stack -w ID</code> for the exact blocking point, then the Web UI for history.',
        'If the <em>worker fleet</em> itself is down, queries can’t be answered (see below), so the runbook’s fallback is <code>temporal workflow describe</code> and the Web UI.',
      ],
      tested: [
        'While waiting for the carrier, <code>diagnostics</code> reports <code>awaiting_carrier</code>, <code>waiting_on = "signal: carrier_confirmed"</code>, a history length ≥ 5, and <code>continue_as_new_suggested = false</code>.',
        '<code>__stack_trace</code> returns text naming the workflow (Python: the pending <code>run (workflow: ShipmentWorkflow …)</code> task; TypeScript: <code>at shipmentWorkflow (…)</code>).',
        '<code>__enhanced_stack_trace</code> returns a structured trace with the SDK name and version.',
        '<code>__temporal_workflow_metadata</code> lists the workflow type, our <code>diagnostics</code> query <em>with its description</em>, the three built-in queries, the <code>carrier_confirmed</code> signal with its description, and the current details text.',
        'After the signal the workflow completes and <code>diagnostics</code> still answers: stage <code>done</code>, nothing awaited.',
      ],
      pitfalls: [
        'The Python <code>__stack_trace</code> output is long and includes SDK/threading internals; look for the line naming your <code>run</code> task. TypeScript’s is a clean <code>at fn (file:line)</code>.',
        '<code>set_current_details</code> / <code>setCurrentDetails</code> is a newer SDK feature; check that your SDK version has it. We used Python 1.34.0 and TypeScript 1.24.0.',
        'Don’t put secrets or PII in <code>waiting_on</code> or current details: they are readable by anyone who can query or view the workflow.',
        'Keep stage transitions in <b>one</b> helper; scattering <code>self.stage = ...</code> assignments is how the diagnostics drift from reality.',
        'Queries need a worker. When the problem <em>is</em> the worker (crashed, wrong task queue), you get <code>FAILED_PRECONDITION</code> and must fall back to describe/history.',
      ],
      variations: ['Add the list of pending activities and their attempt counts (kept in workflow state).', 'A “days waiting” field and a Schedule that alerts when it exceeds an SLA.', 'Expose the same snapshot as a Web UI summary via current details only.'],
    },
  ],

  checklist: `
    <h2>Production checklist for query-driven reads</h2>
    <ul>
      <li>☐ Handlers are synchronous, read-only and O(1); no mutation, no awaits, no activities.</li>
      <li>☐ Results are typed, bounded in size and copied (no leaking live mutable state).</li>
      <li>☐ Timestamps use workflow time; the UI treats them as “as of last update”.</li>
      <li>☐ Callers poll after signals; actions that must return their effect use Updates.</li>
      <li>☐ API maps query-failed (answer is an error), reject conditions, and FAILED_PRECONDITION / timeouts (503, retry) separately.</li>
      <li>☐ Client calls have a timeout, and viewers share a short-lived cache instead of each issuing queries.</li>
      <li>☐ Dashboards that list many workflows use visibility, not query fan-out.</li>
      <li>☐ A diagnostics query, handler descriptions and current details exist for every long-running workflow type.</li>
      <li>☐ Runbook uses <code>temporal workflow query</code>, <code>temporal workflow stack</code> and <code>describe</code>.</li>
      <li>☐ Worker cache is sized sensibly and workers are monitored; no worker means no queries.</li>
    </ul>`,

  sources: [
    ['Message passing: Python SDK (Queries)', 'https://docs.temporal.io/develop/python/message-passing'],
    ['Message passing: TypeScript SDK (Queries)', 'https://docs.temporal.io/develop/typescript/message-passing'],
    ['Signals, Queries and Updates (concepts)', 'https://docs.temporal.io/encyclopedia/workflow-message-passing'],
    ['Temporal CLI: workflow query / stack / describe', 'https://docs.temporal.io/cli/workflow'],
    ['Sticky Execution (why a cache miss means replay)', 'https://docs.temporal.io/sticky-execution'],
    ['Temporal Cloud system limits', 'https://docs.temporal.io/cloud/limits'],
    ['Community: signal + query sequence guarantee (not official)', 'https://community.temporal.io/t/temporal-signal-query-sequence-guarantee/5545'],
  ],

  quiz: [
    { q: 'You run 1,000 queries against a workflow. How many events does that add to its Event History?', o: ['1,000', '2,000', 'One per distinct query name', 'None'], a: 3, why: 'Queries never write history. We compared event counts with and without heavy polling and they were identical.' },
    { q: 'Your query handler throws an exception. What happens to the workflow?', o: ['The workflow fails', 'The workflow task fails and retries forever', 'Nothing: the caller gets a query error and the workflow keeps running', 'The workflow is terminated'], a: 2, why: 'Unlike signal/update handlers, a query error never fails a workflow task. (A handler that blocks the thread too long can, so keep them instant.)' },
    { q: 'All your workers are down. Can you query a workflow that completed an hour ago?', o: ['Yes, the Temporal Service stores the state', 'No: a worker must replay history to answer, so you get FAILED_PRECONDITION', 'Yes, but only with a reject condition', 'Yes, via the Web UI query tab without a worker'], a: 1, why: 'Queries are always answered by a worker, even for closed workflows; we saw “no poller seen for task queue recently”.' },
    { q: 'You send a signal and immediately query. Is the signal’s effect guaranteed to be visible?', o: ['Yes, always', 'No: the docs make no such guarantee, so poll, or use an Update if you need the result of a write', 'Only in Python', 'Only if you use reject conditions'], a: 1, why: 'A signal returns when accepted, not when handled. Poll with a query, or use an Update that returns the new state.' },
    { q: 'Why does the progress query use counters instead of summing a list of processed records?', o: ['Counters are required by the SDK', 'Handlers must be O(1): a big computation slows every poll and risks blocking the workflow thread', 'Lists can’t be returned from queries', 'Queries cannot read lists'], a: 1, why: 'Many observers poll constantly, so the handler must be cheap, and bounded output keeps payloads small.' },
  ],
};
