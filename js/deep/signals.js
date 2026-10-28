'use strict';

/*
 * Deep dive: Signals.
 * Facts come from docs.temporal.io (see `sources`); every use case's code is the file in
 * examples/signals/* that passed its test suite (Python 1.34.0, TypeScript 1.24.0, 2026-10-27).
 */
DEEP.signals = {
  title: 'Signals in depth',
  badge: 'deepSignals',
  verified: 'Verified 2026-10-27 · temporalio Python 1.34.0 · @temporalio/* TypeScript 1.24.0 · 7 tests per language against the Temporal time-skipping test server',

  under: `
    <h2>Under the hood</h2>
    <h3>What actually happens when you send a signal</h3>
    <table>
      <tr><th>#</th><th>Step</th><th>Detail</th></tr>
      <tr><td>1</td><td>Client calls <code>signal</code></td><td>Any Temporal Client, the CLI, or another Workflow can send one.</td></tr>
      <tr><td>2</td><td>Service accepts it</td><td>It is written to Event History as <code>WorkflowExecutionSignaled</code> (with the signal name and its input). The call <b>returns now</b>: it does not wait for the workflow to process the signal.</td></tr>
      <tr><td>3</td><td>A Workflow Task is scheduled</td><td>A worker picks it up, replays history, and delivers the signal to your handler.</td></tr>
      <tr><td>4</td><td>Your handler runs</td><td>It changes workflow state. Your main workflow code reacts, typically via <code>condition()</code> / <code>wait_condition()</code>.</td></tr>
    </table>
    <div class="callout key"><b class="t">Consequence</b>A successful <code>signal()</code> means “durably recorded”, not “applied”. If you need to know the effect happened, poll with a Query, or use an Update instead.</div>

    <h3>Handler rules (from the SDK docs)</h3>
    <ul>
      <li>Signal handlers can mutate state but <b>cannot return a value</b>.</li>
      <li>Signal and Update handlers <b>can be async</b>. Async handlers and the main workflow function then run concurrently and interleave at every <code>await</code>, so protect shared state with a lock (<code>asyncio.Lock</code> in Python; a mutex such as <code>async-mutex</code> in TypeScript).</li>
      <li>You can only signal executions that <b>haven’t closed</b>.</li>
      <li>Register handlers <b>before your first await</b> (TypeScript) / define them as methods (Python) so a signal that arrives with the start request is never missed. Use <code>condition()</code> inside a handler if it needs async initialisation first.</li>
      <li>If your workflow can finish while async handlers are still running, wait for them first: <code>await condition(allHandlersFinished)</code> (TS) / <code>await workflow.wait_condition(workflow.all_handlers_finished)</code> (Python). By default the Worker logs a warning about unfinished handlers; <code>unfinishedPolicy</code> / <code>unfinished_policy</code> silences it per handler.</li>
      <li><b>Never call Continue-As-New from inside a handler.</b> Wait for handlers in the main workflow, then continue.</li>
    </ul>

    <h3>Ways to send</h3>
    <ul>
      <li><b>From a client:</b> <code>handle.signal(...)</code>.</li>
      <li><b>Signal-With-Start (client only):</b> if a workflow with that ID is running it is signalled; otherwise it is started and then signalled, in one atomic call. It cannot be called from inside a workflow.</li>
      <li><b>Workflow → workflow:</b> <code>getExternalWorkflowHandle(id).signal(...)</code> (TS) / the external workflow handle (Python).</li>
    </ul>

    <h3>Limits to design around</h3>
    <table>
      <tr><th>Limit</th><th>Value (Temporal Cloud docs)</th></tr>
      <tr><td>Signals per Workflow Execution</td><td>10,000. The Cloud limits page says signals beyond this are not processed; the Events page says the execution is terminated. Either way, design to stay far below it.</td></tr>
      <tr><td>Event History</td><td>Warning at 10,240 events / 10 MB; hard limit 51,200 events / 50 MB (applies to self-hosted too)</td></tr>
      <tr><td>Single payload</td><td>2 MB</td></tr>
      <tr><td>Pending signals sent to <em>external</em> workflows</td><td>2,000, counted together with incomplete activities, child workflows and cancellations</td></tr>
    </table>
    <p>Self-hosted defaults for the first and last rows aren’t stated on those pages, so check your own cluster’s dynamic config.</p>

    <h3>The core design rule</h3>
    <div class="callout tip"><b class="t">Record in the handler, decide in the run loop</b>Keep signal handlers tiny: validate, append to a list, flip a flag. Put the decisions, the activity calls and the timers in the main workflow function, where ordering is explicit. All three use cases below follow this rule.</div>`,

  cases: [
    /* -------------------------------------------------------------- 1 */
    {
      key: 'cart', level: 'Medium', title: 'Shopping cart: create-or-append, checkout, abandonment',
      scenario: 'A storefront lets customers add items from many pages and devices. The first “add to cart” must create the cart; later ones must append to it. If the customer goes quiet for 24 hours you email a reminder and close the cart.',
      why: 'Signal-With-Start removes the race between “does the cart exist yet?” and “add the item”. A durable timer replaces the cron job and the “last activity” database column.',
      design: [
        'One workflow per customer, Workflow ID <code>cart-&lt;customerId&gt;</code>, so there can only ever be one running cart per customer.',
        'Two signals: <code>add_item</code> and <code>checkout</code>. Handlers only update lists and flags.',
        'The run loop waits for “checked out <em>or</em> something changed”, with a 24-hour timeout. Each new item loops around and <b>restarts the idle timer</b>.',
        'On timeout: send the reminder (an activity) and return <code>abandoned</code>. On checkout: create the order (an activity).',
        'The client never checks whether the cart exists: it always calls Signal-With-Start.',
      ],
      tested: [
        'Two <code>add_to_cart</code> calls reach the <b>same</b> running workflow (first starts it, second only signals it).',
        'Checkout returns <code>ordered</code> with both items.',
        '24 hours of silence returns <code>abandoned</code> (time-skipping test server).',
        'Adding an item at hour 23 resets the timer: still running at hour 46, which would have been abandoned without the reset.',
      ],
      pitfalls: [
        'Python: pass <code>start_signal</code> / <code>start_signal_args</code> to <code>start_workflow</code>. TypeScript: <code>client.workflow.signalWithStart</code>.',
        'In TypeScript register both handlers before the first <code>await</code>.',
        'Once the cart closes, the same Workflow ID can start a fresh cart on the next add; that is governed by the Workflow ID reuse policy.',
        'The customer <em>identity</em> is not authenticated by Temporal. Authenticate in your API before you signal.',
      ],
      variations: ['Remove items with a <code>remove_item</code> signal.', 'Show the live cart in the UI with a Query (module 6).', 'Reject invalid items synchronously by switching <code>add_item</code> to an Update (module 7).'],
    },
    /* -------------------------------------------------------------- 2 */
    {
      key: 'approval', level: 'Hard', title: 'Approval chain with escalation and an audit trail',
      scenario: 'An expense goes to a manager. If they don’t respond within 4 hours it escalates to the director, then the VP. Only the person currently responsible may decide, a late answer from a previous approver must be ignored, and compliance needs a complete audit trail.',
      why: 'The workflow itself is the state machine: who is “current”, what was decided, what timed out. Timers cost nothing while waiting and survive deploys and crashes, so “4 hours” can be “4 days”.',
      design: [
        'The workflow keeps <code>current</code> (who we are waiting on), <code>decision</code> and an <code>audit</code> list.',
        'The <code>decide</code> signal handler enforces the rule “only the current approver, and only once”. Anything else is <b>recorded as ignored</b>, not acted on.',
        'The run loop walks the chain: set <code>current</code>, notify (activity), wait for a decision with a per-level timeout. Timeout → audit entry → next level.',
        'A Query exposes <code>waiting_on</code> and the audit trail, so a UI can show live status without touching the workflow.',
        'End states: <code>approved</code>, <code>rejected</code> or <code>expired</code> (nobody answered).',
      ],
      tested: [
        'A signal from someone who isn’t the current approver is ignored and logged; the real approver’s decision then wins.',
        'No answer for 5 hours: the workflow is now waiting on <code>director</code>.',
        'The manager’s <b>late</b> approval is ignored after escalation; the director’s rejection wins. Audit: <code>manager timed out, escalating</code> → <code>ignored decision from manager</code> → <code>director rejected</code>.',
        'Nobody answers at any level: result <code>expired</code>.',
      ],
      pitfalls: [
        'Don’t make decisions inside the handler. The handler only records, so ordering and timeouts stay readable in one place.',
        'Reset <code>decision</code> whenever <code>current</code> changes; otherwise a stale decision leaks into the next level.',
        'TypeScript: a variable assigned in a closure is still narrowed by the compiler after you set it to <code>undefined</code>. Re-read it through a cast (see the code) rather than silencing the error.',
        'Use <code>levelTimeout</code> as a <em>workflow input</em>, not a constant, so each request type can have its own SLA.',
      ],
      variations: ['“Any 2 of 3 approvers” using a set of approvals.', 'A <code>reassign</code> signal to change <code>current</code> mid-wait.', 'Periodic reminders: loop on a shorter timeout and notify again.', 'If the approver’s UI needs an immediate “not allowed” response, use an Update with a validator instead of a Signal.'],
    },
    /* -------------------------------------------------------------- 3 */
    {
      key: 'entity', level: 'Hard', title: 'Long-lived account entity: ordered, de-duplicated, never-ending',
      scenario: 'Each bank account is a single long-lived workflow that receives deposits and withdrawals from several upstream systems. Events must be applied one at a time in arrival order, duplicate deliveries must be ignored, and the workflow must run for years without its history growing forever.',
      why: 'A single workflow per entity serialises every change without locks or database transactions. Continue-As-New keeps the history bounded while the entity lives on under the same Workflow ID.',
      design: [
        'Workflow ID = account ID. State (<code>balance</code>, <code>pending</code> inbox, <code>seen</code> event IDs, <code>closing</code>, <code>generation</code>) is a single object that is passed to the next run.',
        'The <code>apply</code> signal handler does two things only: drop the event if its <code>event_id</code> was already seen, otherwise append to <code>pending</code>.',
        'The run loop drains <code>pending</code> strictly FIFO, one activity per event (an <b>idempotent</b> ledger write).',
        'After <code>MAX_EVENTS_PER_RUN</code> events, or when the server suggests it (<code>continueAsNewSuggested</code>), wait for all handlers to finish and Continue-As-New, carrying <b>everything</b>: balance, remaining <code>pending</code>, a bounded <code>seen</code> window and the <code>closing</code> flag.',
        'A <code>close</code> signal ends the entity once the inbox is empty.',
      ],
      tested: [
        '25 events plus 3 duplicate deliveries: final balance is exactly <b>25</b>.',
        'The entity continued-as-new at least twice (generation ≥ 3) <b>while signals were still arriving</b>, with no event lost or applied twice.',
        'The <code>close</code> signal sent during the run is honoured by the latest run.',
      ],
      pitfalls: [
        '<b>A bug we hit while verifying:</b> checking the continue-as-new threshold only <em>after</em> draining the inbox let a 25-event backlog run inside one run, so it never continued. Check the limit <b>inside</b> the drain loop.',
        'Carry <code>closing</code> (and any other flag a signal can set) in the state. Otherwise a signal handled in run N is forgotten in run N+1.',
        'Never call Continue-As-New from inside a handler. Wait with <code>allHandlersFinished</code> in the main loop, then continue.',
        'Dedupe memory must be bounded (<code>MAX_SEEN</code>). The trade-off: a duplicate older than the window is not caught, so keep the downstream write idempotent too (<code>ON CONFLICT DO NOTHING</code>).',
        'Signals that arrive while a Continue-As-New is being decided are not dropped: the server won’t complete the continue past an undelivered signal, it retries the workflow task so the signal is handled. The official pages don’t spell this out (it is confirmed in Temporal community answers), but the test above exercises exactly that overlap.',
        'Don’t assume ordering <em>across</em> different senders. If business order matters, put a sequence number in the event and enforce it in the run loop.',
        'History limits apply per run, which Continue-As-New resets; the 10,000-signal limit is why unbounded entities <em>must</em> continue-as-new.',
      ],
      variations: ['Shard one hot entity across several workflows by key.', 'Start entities lazily with Signal-With-Start.', 'Replace <code>apply</code> with an Update when the sender needs the new balance or a rejection back (insufficient funds).', 'Serve balance reads with the Query shown in the code.'],
    },
  ],

  checklist: `
    <h2>Production checklist for signal-driven workflows</h2>
    <ul>
      <li>☐ Handlers are tiny; decisions live in the main loop.</li>
      <li>☐ Payloads carry an <b>idempotency/event ID</b> and handlers de-duplicate.</li>
      <li>☐ Everything a signal can change is part of the state you pass to Continue-As-New.</li>
      <li>☐ <code>allHandlersFinished</code> awaited before returning or continuing-as-new (if any handler is async).</li>
      <li>☐ A hard cap on signals per run, well below 10,000; Continue-As-New before history warnings (10,240 events / 10 MB).</li>
      <li>☐ Signals sent to possibly-closed workflows are handled: catch the error, or use Signal-With-Start.</li>
      <li>☐ Replay test added for the workflow (so a code change never breaks running entities).</li>
      <li>☐ Callers authenticate the human before sending a signal. Temporal doesn’t.</li>
    </ul>`,

  sources: [
    ['Message passing: TypeScript SDK', 'https://docs.temporal.io/develop/typescript/message-passing'],
    ['Message passing: Python SDK', 'https://docs.temporal.io/develop/python/message-passing'],
    ['Sending messages to Workflows', 'https://docs.temporal.io/sending-messages'],
    ['Signals, Queries and Updates (concepts)', 'https://docs.temporal.io/encyclopedia/workflow-message-passing'],
    ['Continue-As-New: Python', 'https://docs.temporal.io/develop/python/continue-as-new'],
    ['Continue-As-New: TypeScript', 'https://docs.temporal.io/develop/typescript/continue-as-new'],
    ['Event reference', 'https://docs.temporal.io/references/events'],
    ['Temporal Cloud system limits', 'https://docs.temporal.io/cloud/limits'],
  ],

  quiz: [
    { q: 'Your client’s signal() call returned without error. What is guaranteed?', o: ['The handler has run', 'The signal was accepted and durably recorded in history', 'The workflow state changed', 'The workflow is still running'], a: 1, why: 'The call returns once the service accepts it. Processing happens later, on a worker.' },
    { q: 'In the account entity, why is the Continue-As-New threshold checked inside the drain loop?', o: ['It is faster', 'Otherwise a large backlog is drained in one run and its history keeps growing', 'Signals can’t be read outside the loop', 'Continue-As-New only works inside loops'], a: 1, why: 'We hit exactly this while verifying: 25 queued events never triggered a continue because the check ran only after draining.' },
    { q: 'Why is the closing flag part of the state passed to Continue-As-New?', o: ['To make the payload larger', 'A flag set by a signal in this run would otherwise be lost in the next run', 'Because Continue-As-New resets signals', 'It is required by the SDK'], a: 1, why: 'Anything a signal can change must be carried over, or the new run forgets it.' },
    { q: 'A late approval arrives from an approver who has already been escalated past. Best behaviour?', o: ['Apply it anyway', 'Throw from the handler so the signal is retried', 'Record it as ignored in the audit trail and keep waiting for the current approver', 'Terminate the workflow'], a: 2, why: 'The handler records and rejects cleanly; the run loop stays in control of the outcome.' },
    { q: 'You have async signal handlers and your workflow is about to return or continue-as-new. What should you do first?', o: ['Nothing', 'Wait with allHandlersFinished (all_handlers_finished)', 'Call Continue-As-New from each handler', 'Sleep for a minute'], a: 1, why: 'Otherwise handlers may be cut off mid-flight; the docs say to wait in the main workflow, never to continue-as-new from a handler.' },
  ],
};
