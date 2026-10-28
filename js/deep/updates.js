'use strict';

/*
 * Deep dive: Updates.
 * Facts come from docs.temporal.io and the SDK API docs (see `sources`); every use case's code is the
 * file in examples/updates/* that passed its tests (Python 1.34.0, TypeScript 1.24.0, 2026-10-27).
 */
DEEP.updates = {
  title: 'Updates in depth',
  badge: 'deepUpdates',
  verified: 'Verified 2026-10-27 · temporalio Python 1.34.0 · @temporalio/* TypeScript 1.24.0 · every scenario passes in both languages against a local Temporal dev server (CLI 1.9.1, server 1.32.0)',

  under: `
    <h2>Under the hood</h2>
    <h3>The life of an update</h3>
    <table>
      <tr><th>#</th><th>Step</th><th>What is written to Event History</th></tr>
      <tr><td>1</td><td>Client sends the update (<code>execute_update</code> / <code>executeUpdate</code>).</td><td>Nothing yet.</td></tr>
      <tr><td>2</td><td>A worker runs your <b>validator</b> (if any).</td><td>If it throws: the caller gets an error and <b>nothing is written</b>. The Events reference puts it plainly: “A rejected Update doesn’t produce an Event.”</td></tr>
      <tr><td>3</td><td>Validator passes → update is <b>accepted</b>.</td><td><code>WorkflowExecutionUpdateAccepted</code></td></tr>
      <tr><td>4</td><td>Your handler runs (it may await activities, timers, conditions).</td><td>Whatever the handler schedules.</td></tr>
      <tr><td>5</td><td>Handler returns → the caller receives the result.</td><td><code>WorkflowExecutionUpdateCompleted</code></td></tr>
    </table>
    <p>Without a validator every update is accepted. Because rejected updates cost nothing in history, validators are your main tool for staying inside the update limits (below).</p>

    <h3>Sending updates</h3>
    <ul>
      <li><b>Wait for the result:</b> <code>execute_update</code> / <code>executeUpdate</code> returns the handler’s result.</li>
      <li><b>Wait only until accepted:</b> <code>start_update(..., wait_for_stage=ACCEPTED)</code> / <code>startUpdate(..., { waitForStage: ACCEPTED })</code> returns an update handle once the worker has accepted it (so it is persisted). Call <code>result()</code> later. Fetch a handle for an in-flight update by its ID with <code>get_update_handle_for</code> / <code>getUpdateHandle</code>.</li>
      <li>The SDKs’ stage enums also contain <code>ADMITTED</code>; the docs page doesn’t describe it, so this lesson sticks to <code>ACCEPTED</code> and <code>COMPLETED</code>.</li>
      <li>Updates can’t be sent directly from one workflow to another. Send them from an Activity using a Temporal Client.</li>
    </ul>

    <h3>Update IDs: free idempotency</h3>
    <p>Every update has an ID (Python: <code>id=</code>; TypeScript: <code>updateId</code>). If you don’t supply one the client generates a random one. If the server receives <b>two updates with the same ID for the same workflow run, the second returns a handle to the first</b> instead of running again (stated in the TypeScript SDK API docs, and demonstrated by the tests below). Use a business key such as a request ID.</p>

    <h3>How handler errors behave: the most important rule</h3>
    <table>
      <tr><th>Where</th><th>What you throw</th><th>Result</th></tr>
      <tr><td>Validator</td><td>any exception</td><td>Update <b>rejected</b>; caller gets <code>WorkflowUpdateFailedError</code>; no history.</td></tr>
      <tr><td>Handler</td><td><code>ApplicationError</code> / <code>ApplicationFailure</code> (or an activity failure)</td><td>Update <b>fails</b>; caller gets <code>WorkflowUpdateFailedError</code>; the workflow keeps running.</td></tr>
      <tr><td>Handler</td><td>a <b>plain exception</b> (<code>ValueError</code>, <code>Error</code>)</td><td>Treated as a bug: the <b>workflow task fails and retries</b>. <b>The update never completes</b>, the caller just waits, and the workflow stays Running.</td></tr>
    </table>
    <div class="callout warn"><b class="t">We reproduced this</b>The last row isn’t spelled out in the pages we read, so we tested it: a handler raising <code>ValueError</code> (Python) or <code>new Error()</code> (TypeScript) left the client waiting until its own timeout, with the workflow still <code>RUNNING</code>. To fail an update on purpose, throw an <code>ApplicationError</code>/<code>ApplicationFailure</code>.</div>

    <h3>Concurrency and shutdown rules</h3>
    <ul>
      <li>Update handlers may be <code>async</code>; concurrent invocations interleave at every <code>await</code>. Protect shared state with <code>asyncio.Lock</code> (Python) or a mutex such as <code>async-mutex</code> (TypeScript).</li>
      <li>Before the workflow returns, wait for handlers: <code>allHandlersFinished</code> / <code>all_handlers_finished</code>.</li>
      <li>Don’t call Continue-As-New from inside an update handler; wait for handlers in the main workflow first. Use <code>currentUpdateInfo</code> / <code>current_update_info</code> (it exposes the update ID) if you need to de-duplicate across a Continue-As-New.</li>
      <li><b>Updates that arrive with the start request can run before the first line of your <code>run</code> body.</b> In Python initialise state in <code>@workflow.init</code> (we hit this bug while verifying, see use case 1); in TypeScript initialise state and register handlers before the first <code>await</code>.</li>
      <li>If the workflow finishes while a handler is running, the caller gets an RPC error (<code>NOT_FOUND</code>); an update sent to an already-closed workflow also fails with an RPC error, not a validation error. Treat <code>WorkflowUpdateFailedError</code> (“the workflow said no”) and RPC errors (“the call didn’t land”) differently in your API.</li>
      <li>If no worker is polling, the SDK retries the update indefinitely. Wrap the call in a timeout (Python: <code>asyncio.timeout</code> → <code>WorkflowUpdateRPCTimeoutOrCancelledError</code>).</li>
    </ul>

    <h3>Limits to design around</h3>
    <table>
      <tr><th>Limit</th><th>Value (Temporal Cloud docs)</th></tr>
      <tr><td>In-flight updates per workflow execution</td><td>10</td></tr>
      <tr><td>Total updates in one run’s history</td><td>2,000 (the Events page says the execution is terminated past 2,000)</td></tr>
      <tr><td>History</td><td>Warning at 10,240 events / 10 MB; hard limit 51,200 events / 50 MB</td></tr>
    </table>
    <p>Self-hosted values aren’t stated on those pages. Server versions: updates need 1.25.0+ (earlier versions require a dynamic-config flag); Update-With-Start is recommended on 1.28+ for open source.</p>

    <h3>Update-With-Start</h3>
    <p>“Sends an update request, starting a workflow if necessary.” You must pass a <code>WorkflowIDConflictPolicy</code>. The docs describe two patterns:</p>
    <ul>
      <li><b>Lazy initialisation:</b> <code>USE_EXISTING</code>. Update the workflow if it exists, create it first if not (a cart created on first use).</li>
      <li><b>Early return:</b> <code>FAIL</code> plus a unique update ID. Start a workflow and get a synchronous answer while the long process continues in the background (use case 3).</li>
    </ul>
    <div class="callout warn"><b class="t">Not atomic</b>Unlike Signal-With-Start, Update-With-Start is <b>not atomic</b>. If the update can’t be delivered (for example no worker is running) the workflow still starts, and the SDKs retry the update with no guarantee it succeeds. Make the update idempotent and give it an update ID.</div>`,

  cases: [
    /* -------------------------------------------------------------- 1 */
    {
      key: 'address', level: 'Medium', title: 'Order address change: validated, with an answer',
      scenario: 'A customer wants to change the delivery address of an order from the website. The change is only allowed while the order is still being processed, the address must pass basic checks, and the customer should immediately see either the new delivery estimate or a clear reason for the refusal.',
      why: 'A signal could carry the new address but can’t tell the customer “too late, it shipped”. A query can’t change anything. An update validates against the workflow’s <em>current</em> state and returns a result in one round trip.',
      design: [
        'One workflow per order holding <code>address</code> and <code>status</code> (processing → shipped → delivered). Status changes arrive as signals; a Query exposes it.',
        'The <code>change_address</code> update has a <b>validator</b> that rejects when the order has shipped, the street is empty, or the postal code is malformed.',
        'The handler stores the address and returns an <code>AddressChange</code> (the new address plus a delivery estimate). It is synchronous and short, so there is no need for a lock.',
        'The API layer maps <code>WorkflowUpdateFailedError</code> to a 4xx (“refused: &lt;reason&gt;”) and RPC/timeouts to a 5xx (“try again”).',
      ],
      tested: [
        'A valid change returns the new address and ETA to the caller.',
        'A bad postal code and an empty street are rejected with the validator’s message, and the history contains <b>exactly one</b> <code>WorkflowExecutionUpdateAccepted</code> (the successful one). The two rejections left no trace.',
        'After the order is marked shipped, a change is rejected with “already shipped”.',
      ],
      pitfalls: [
        '<b>A bug we hit while verifying:</b> the first Python version set <code>self.address</code> at the top of <code>run()</code>. The update arrived with the start request, was handled <em>before</em> <code>run()</code> executed, and <code>run()</code> then overwrote it (the test failed consistently with “delivered to Berlin”). Initialising in <code>@workflow.init</code> fixes it.',
        'The validator must be synchronous, take the same arguments as the handler and return nothing.',
        'The validator sees the workflow state <b>at the moment it runs</b>. If a “shipped” signal and an address change are sent at nearly the same time, either order is possible, so treat the validator as a fast guard and make the business rule explicit (here: status must still be “processing”).',
        'Validators are for cheap checks. Anything that needs an activity belongs in the handler (use case 2).',
      ],
      variations: ['Compute the ETA with an activity (make the handler async and add a lock).', 'Add a <code>cancel_order</code> update that returns a refund amount.', 'Return a structured error code by throwing <code>ApplicationError</code> with a <code>type</code> from the handler.'],
    },
    /* -------------------------------------------------------------- 2 */
    {
      key: 'seats', level: 'Hard', title: 'Seat reservation under contention',
      scenario: 'Ticket sales for an event: many people try to book seats at the same moment. Two buyers must never get the same seat, a buyer must never be charged for a seat they didn’t get, a retrying browser must not book twice, and a declined card must leave the seat available.',
      why: 'One workflow per event serialises every booking in one place with no database locks. Updates give each buyer a definitive answer (booked or why not), and update IDs make retries safe.',
      design: [
        'State is a map <code>seat → owner</code> (a <b>dictionary</b>, not a set, so iteration order is deterministic).',
        'The <code>reserve</code> update has a cheap <b>validator</b>: sales open, 1–4 seats, seats exist. This is a fast fail, <em>never</em> the only protection.',
        'The <b>handler takes a lock</b>, <b>re-checks availability</b> (the authoritative check), calls the payment-hold activity, and <b>only then marks the seats</b>. If the hold fails, nothing was marked.',
        'The client sends a request ID as the <b>update ID</b>, so a retry returns the first result instead of charging again.',
        'A <code>close_sales</code> signal ends sales; the workflow waits for in-flight handlers and returns the final seat map.',
      ],
      tested: [
        'Two buyers request seat A1 simultaneously: both pass the validator, <b>exactly one wins</b>, the other gets a <code>SeatTaken</code> failure, and <b>only one payment hold was ever placed</b>.',
        'The same update ID sent twice returns the same booking and does <b>not</b> place a second hold.',
        'A declined payment fails the update with the activity’s error, and the seat is still bookable by someone else.',
        'Invalid requests (no seats, unknown seat, too many seats) are rejected and add <b>no</b> accepted events to history.',
        '<code>start_update</code> with <code>ACCEPTED</code> returns early and <code>result()</code> delivers the booking.',
        'After the workflow completes, a further update fails with an RPC error (closed workflow), not a validation error.',
      ],
      pitfalls: [
        '<b>Validators can be stale.</b> Both racing requests were validated before either handler finished, so the validator alone would have double-booked A1. The lock plus the re-check in the handler is what makes it correct.',
        'Mutate state <b>after</b> the side effect succeeds. If you mark seats first and the payment fails, you must remember to undo it.',
        'Throw <code>ApplicationError</code>/<code>ApplicationFailure</code> for expected refusals (<code>SeatTaken</code>). A plain exception would hang the update (see “How handler errors behave”).',
        'Don’t use a hash-ordered set to iterate seats in workflow code; its order can differ between processes and break replay.',
        'There are limits on concurrent in-flight updates (10 per workflow on Cloud). For very hot events shard seats across several workflows (e.g. one per section).',
      ],
      variations: ['Seat holds with expiry: reserve for 10 minutes, then release via a timer.', 'A <code>release</code> update when the buyer abandons checkout.', 'Shard one event into one workflow per section and route by seat.'],
    },
    /* -------------------------------------------------------------- 3 */
    {
      key: 'payment', level: 'Hard', title: 'Payment with Update-With-Start: instant answer, slow follow-up',
      scenario: 'Checkout must tell the shopper “payment approved” or “declined” within a second, but capturing, settling and receipting can take days. There must be exactly one payment workflow per order, even if the browser retries.',
      why: 'Update-With-Start starts the workflow and returns the authorisation result in a single call, while the long-running part carries on in the background. The workflow ID prevents duplicate payments; the update ID makes retries idempotent.',
      design: [
        'Workflow ID <code>payment-&lt;orderId&gt;</code>, started with <code>WorkflowIDConflictPolicy.FAIL</code>: a second payment for the same order is an error.',
        'The <code>authorize</code> update (async handler) runs the authorisation activity under a lock, <b>stores the decision</b>, and returns it. If the card is declined it throws <code>ApplicationError</code> so the caller sees a failure.',
        'The main workflow waits until an authorisation is recorded and handlers are finished, then (if approved) captures, waits for a settlement window with a durable timer, and sends the receipt.',
        'The client passes a stable <b>update ID</b> (e.g. the request ID). A retry with the same ID returns the original result.',
      ],
      tested: [
        'The call returns the approval while the workflow is still <code>RUNNING</code>; later it completes with <code>settled</code>.',
        'Repeating the call with the <b>same update ID</b> returns the same result and starts nothing new, <b>even though the conflict policy is <code>FAIL</code></b>. This matches the docs: an existing update with that ID is attached to regardless of policy.',
        'A call with a <b>different</b> update ID for the same order fails with “workflow already started”.',
        'A declined card fails the update with <code>CardDeclined</code> and the workflow ends as <code>declined</code>.',
      ],
      pitfalls: [
        '<b>Not atomic.</b> If the update can’t be delivered the workflow may start anyway. That is why the update must be idempotent (here: it returns the stored decision if one exists).',
        'With Update-With-Start the update can run before your main function. Register the handler first (TypeScript: before any <code>await</code>; Python: handlers are methods, state lives in <code>__init__</code>).',
        'Pick the conflict policy deliberately: <code>USE_EXISTING</code> for “create or update” (a cart), <code>FAIL</code> for “this must be new” (a payment).',
        'The workflow handle is available from the start operation whether or not the update succeeded; use it for follow-up queries.',
        'A WithStartWorkflowOperation can only be used once. Build a new one per call.',
      ],
      variations: ['Use <code>USE_EXISTING</code> to build a “create-or-update cart” endpoint.', 'Add a <code>refund</code> update that is only valid after settlement.', 'Use <code>start_update</code> with <code>ACCEPTED</code> when you only need to know the request was persisted.'],
    },
  ],

  checklist: `
    <h2>Production checklist for update-driven workflows</h2>
    <ul>
      <li>☐ Validators are cheap and synchronous; the handler re-checks anything that can change while it awaits.</li>
      <li>☐ Expected refusals throw <code>ApplicationError</code>/<code>ApplicationFailure</code>; no plain exceptions in handlers.</li>
      <li>☐ Shared state touched across <code>await</code>s is protected by a lock.</li>
      <li>☐ State is mutated only after the side effect succeeds.</li>
      <li>☐ Callers send a business <b>update ID</b> so retries are safe.</li>
      <li>☐ API maps <code>WorkflowUpdateFailedError</code> (refused) and RPC errors / timeouts (try again) differently.</li>
      <li>☐ Client calls have a timeout (no worker = the SDK retries forever).</li>
      <li>☐ <code>allHandlersFinished</code> awaited before the workflow returns or continues-as-new; never continue-as-new inside a handler.</li>
      <li>☐ Update-With-Start: conflict policy chosen on purpose; update is idempotent because the call is not atomic.</li>
      <li>☐ Stay below 10 in-flight and 2,000 total updates per run; shard or Continue-As-New if you could exceed them.</li>
    </ul>`,

  sources: [
    ['Message passing: TypeScript SDK', 'https://docs.temporal.io/develop/typescript/message-passing'],
    ['Message passing: Python SDK', 'https://docs.temporal.io/develop/python/message-passing'],
    ['Sending messages to Workflows (Updates, Update-With-Start)', 'https://docs.temporal.io/sending-messages'],
    ['Signals, Queries and Updates (concepts)', 'https://docs.temporal.io/encyclopedia/workflow-message-passing'],
    ['Event reference', 'https://docs.temporal.io/references/events'],
    ['Temporal Cloud system limits', 'https://docs.temporal.io/cloud/limits'],
    ['Workflow Execution Events (update limit)', 'https://docs.temporal.io/workflow-execution/event'],
    ['TypeScript SDK API: WorkflowUpdateOptions.updateId', 'https://typescript.temporal.io/api/interfaces/client.WorkflowUpdateOptions'],
  ],

  quiz: [
    { q: 'A validator throws. What is written to Event History?', o: ['WorkflowExecutionUpdateRejected', 'WorkflowExecutionUpdateAccepted then a failure', 'Nothing', 'A failed workflow task'], a: 2, why: 'A rejected update doesn’t produce an event, which is why validators help you stay under the update limits.' },
    { q: 'In the seat-reservation workflow, why does the handler re-check seat availability inside the lock when a validator already checked it?', o: ['Habit', 'The validator can be stale: two racing requests both pass it before either handler finishes', 'Validators can’t read workflow state', 'Locks run before validators'], a: 1, why: 'Both racing requests were validated before either handler completed; only the re-check under the lock prevents a double booking.' },
    { q: 'Your update handler raises a plain ValueError / Error. What happens?', o: ['The update fails and the caller gets an error', 'The workflow fails', 'The workflow task keeps failing and retrying, the update never completes, and the caller waits', 'The exception is swallowed and the handler returns null'], a: 2, why: 'We reproduced this in both SDKs. Use ApplicationError/ApplicationFailure to fail an update deliberately.' },
    { q: 'You call Update-With-Start with the FAIL conflict policy twice for the same order, using the same update ID. What happens to the second call?', o: ['It throws “workflow already started”', 'It starts a second workflow', 'It attaches to the existing update and returns the same result', 'It terminates the first workflow'], a: 2, why: 'An existing update with that ID is attached to regardless of conflict policy. A different update ID would hit the FAIL policy.' },
    { q: 'What is the key difference between Update-With-Start and Signal-With-Start?', o: ['Update-With-Start can’t start workflows', 'Update-With-Start is not atomic: the workflow may start even if the update can’t be delivered', 'Signal-With-Start returns a result', 'There is no difference'], a: 1, why: 'The docs call this out explicitly. Make the update idempotent and give it an update ID.' },
  ],
};
