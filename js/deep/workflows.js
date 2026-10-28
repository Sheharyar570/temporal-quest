'use strict';

/*
 * Deep dive: Workflows.
 * Facts come from docs.temporal.io (see `sources`); behaviour the pages don't state was checked by running it.
 * Every use case's code is the file in examples/workflows/* that passed its tests
 * (Python 1.34.0, TypeScript 1.24.0, 2026-10-28).
 */
DEEP.workflows = {
  title: 'Workflows in depth',
  badge: 'deepWorkflows',
  verified: 'Verified 2026-10-28 · temporalio Python 1.34.0 · @temporalio/* TypeScript 1.24.0 · 13 scenarios pass in Python, 12 in TypeScript, against the SDKs’ time-skipping test server and a local dev server (CLI 1.9.1, server 1.32.0)',

  under: `
    <h2>Under the hood</h2>
    <h3>Replay is the whole trick</h3>
    <p>A worker does not keep your workflow alive in memory for weeks. When it needs to continue an execution (after a restart, a cache eviction, a signal), it <b>re-runs your workflow function from the top against the recorded Event History</b>. Every time your code asks for something (start a timer, schedule an activity, start a child), the SDK emits a <em>Command</em> and compares it with the matching event already in history. A match lets the code move on; a mismatch is a <b>non-determinism error</b>. That is the entire reason for the determinism rules.</p>

    <h3>What counts as a change that breaks replay</h3>
    <ul>
      <li>The docs list the commands whose <b>order, number and kind</b> must not change for running executions without versioning: <b>timers, activities (including local), child workflows, signals sent to other workflows, Nexus operations, ending the execution, patch markers, upserting search attributes or memo, and side-effect calls</b>.</li>
      <li><b>Safe</b> per the docs: changing an activity’s or child’s <em>inputs, return values and timeouts</em>, signal inputs, timer durations (with an exception: changing to or from <code>0</code> is non-deterministic in Java, Python and Go), and adding or removing code that produces no command. Adding a handler for a signal type that was never sent is also safe.</li>
      <li><b>Where time and randomness come from:</b> Python’s sandbox blocks the wall clock. We ran a workflow that called <code>datetime.now()</code>: its workflow task failed and the execution stayed <b>Running</b>, so a bug like this stalls a workflow instead of failing it. Use <code>workflow.now()</code> and <code>workflow.uuid4()</code>. In TypeScript, <code>Date.now()</code> inside a workflow returns a replay-safe time (the trial example uses it) and <code>uuid4()</code> comes from <code>@temporalio/workflow</code>.</li>
      <li><b>A nondeterminism error does not fail the workflow.</b> The workflow task fails and is retried; the execution is <b>blocked, status Running</b>, until you deploy compatible code. We confirmed that rolling the code back lets the same execution finish.</li>
    </ul>

    <h3>Workflow ID, Run ID and the two ID policies</h3>
    <table>
      <tr><th>Policy</th><th>Governs</th><th>Values (default first)</th></tr>
      <tr><td><b>Conflict policy</b></td><td>the ID belongs to an <em>open</em> execution</td><td><code>FAIL</code> (error “already started”) · <code>USE_EXISTING</code> (success, returns the open run’s Run ID) · <code>TERMINATE_EXISTING</code></td></tr>
      <tr><td><b>Reuse policy</b></td><td>the ID belongs to a <em>closed</em> execution still inside the namespace’s retention period (30 days by default)</td><td><code>ALLOW_DUPLICATE</code> · <code>ALLOW_DUPLICATE_FAILED_ONLY</code> · <code>REJECT_DUPLICATE</code> · <code>TERMINATE_IF_RUNNING</code></td></tr>
    </table>
    <p>Two executions with the same Workflow ID can never be open at once, whatever the reuse policy says. The Run ID identifies one execution; Continue-As-New, retries and schedules create new runs under one Workflow ID. The docs warn not to store the <em>current</em> Run ID or branch on it, because it can change.</p>

    <h3>History limits and Continue-As-New</h3>
    <p>Per the docs, the service logs a warning at <b>10,240 events</b> and <b>terminates the execution above 51,200 events</b>, above <b>2,000 updates</b> or above <b>10,000 signals</b>. <b>Continue-As-New</b> closes the run and starts a new one with the <b>same Workflow ID, a new Run ID and an empty history</b>; whatever state matters is passed as the new run’s input. Check <code>is_continue_as_new_suggested()</code> / <code>workflowInfo().continueAsNewSuggested</code> at a point where you are ready to checkpoint. Don’t continue from inside a signal or update handler: let the handlers finish first. In-flight child workflows do <b>not</b> carry over to the new run.</p>

    <h3>Child workflows: use when an activity isn’t enough</h3>
    <p>The docs’ advice is blunt: <b>“When in doubt, use an Activity.”</b> A child is worth it when you need its own history and ID (so a big fan-out doesn’t bloat the parent), its own retries/timeouts/search attributes, or to outlive the parent (<code>ABANDON</code>). Children cost more history events than activities, and the docs say a single parent <b>should not spawn more than 1,000 children</b>. The <b>Parent Close Policy</b> decides what happens to running children when the parent closes: <code>TERMINATE</code>, <code>REQUEST_CANCEL</code> or <code>ABANDON</code>.</p>

    <h3>Changing code that’s already running</h3>
    <p>Patching is a <b>three-step</b> process: (1) wrap the new code in <code>patched("id")</code> and keep the old branch; (2) once no pre-patch execution is left, replace it with <code>deprecate_patch("id")</code>; (3) once those have left retention, delete the call. <code>patched()</code> writes a <b>marker</b> into history; a marker in history that the code doesn’t produce fails the workflow task, while <code>deprecate_patch()</code>’s marker may be absent. The docs also describe <b>Worker Versioning</b> (pinning executions to a deployed version) and “workflow cutovers” (a copy under a new name) as alternatives, and they <b>recommend Worker Versioning</b>. We tested patching only.</p>
    <div class="callout"><b class="t">Replay tests are your CI safety net</b>Download histories of recent open <em>and</em> closed executions per task queue, replay them with the new code, and fail the build on any error (<code>Replayer.replay_workflow</code> in Python, <code>Worker.runReplayHistory</code> in TypeScript). Use <b>histories that have moved past the code you changed</b> — see use case 2 for why.</div>
  `,

  cases: [
    /* -------------------------------------------------------------- 1 */
    {
      key: 'trial', level: 'Medium', title: 'A free-trial lifecycle: durable timers and the determinism rules',
      scenario: 'A user starts a 14-day trial. Send a welcome email now, a reminder on day 11 and an “expired” email on day 14, unless they convert first, in which case send “thanks” immediately. One trial per user, and a deploy or worker crash must never lose a timer.',
      why: 'This is the smallest real workflow, and every ingredient is a determinism rule in action: durable timers instead of sleeping threads, workflow-safe clock and UUID, signals to change course, and the Workflow ID doing de-duplication.',
      design: [
        'The workflow sends mail through an <b>activity</b> (a side effect), keyed with a <b><code>workflow.uuid4()</code></b> so a retried send is harmless.',
        'Waiting is <code>wait_condition(converted, timeout=…)</code> / <code>condition(() =&gt; converted, ms)</code>: <b>one durable timer that is cancelled the moment the signal arrives</b>. Nothing runs while it waits.',
        'The start time comes from <b><code>workflow.now()</code> / <code>Date.now()</code></b>, never the machine clock, and a <b>query</b> returns the trial end date.',
        'The user ID is the <b>Workflow ID</b>, so a second start for the same user is rejected by the server instead of by your code.',
      ],
      tested: [
        'With no conversion the workflow sends <b>welcome → reminder → expired</b>. On the time-skipping test server 14 simulated days finished in under 10 s of real time.',
        'Converting after day 12 sends <b>welcome → reminder → thanks</b>.',
        '<b>Replay:</b> a worker was shut down, a brand-new one answered the <code>ends_at</code> query with the <b>identical value</b> (rebuilt from history, not memory), and replaying the finished history against the same code passed.',
        '<b>Determinism violation:</b> the same workflow type rewritten without the welcome email is rejected on replay (<code>NondeterminismError</code> in Python, <code>DeterminismViolationError</code> in TypeScript).',
        '<b>Python sandbox:</b> a workflow calling <code>datetime.now()</code> had a failed workflow task and stayed Running (a stuck workflow, not a failed one).',
        '<b>ID policies:</b> a duplicate start fails by default; <code>USE_EXISTING</code> returns the same Run ID; <code>TERMINATE_EXISTING</code> replaces the run (old one Terminated); after completion <code>REJECT_DUPLICATE</code> and <code>ALLOW_DUPLICATE_FAILED_ONLY</code> are refused while the default allows a new run.',
      ],
      pitfalls: [
        '<b>Python dataclass fields must be JSON-friendly.</b> Our first draft had <code>timedelta</code> fields and failed to start; we pass days as integers.',
        '<b>Don’t reach for <code>asyncio.sleep</code>, <code>setTimeout</code> or a loop with the clock.</b> Use the workflow’s own timer; only it is recorded in history and survives restarts.',
        'The Run ID can change (retries, resets, continue-as-new). Dedupe on the <b>Workflow ID</b> and don’t put a Run ID in business logic.',
        'Changing a timer from or to <code>0</code> is non-deterministic in Python (docs); other duration changes are safe.',
        '<b>A not-yet-tested edge:</b> on the time-skipping server, a query sent right after swapping to a new worker timed out in our first attempt, so the replay-by-new-worker test runs on the local dev server instead. We did not investigate why.',
      ],
      variations: ['Persist “reminder sent” with a <b>search attribute</b> so support can list trials awaiting a reminder.', 'Replace the fixed 14 days with a value from the input so plans can differ (changing an <em>input</em> is safe).', 'Add an <b>update</b> “extend trial by N days” that adjusts the deadline.'],
    },
    /* -------------------------------------------------------------- 2 */
    {
      key: 'order', level: 'Hard', title: 'Shipping a change while orders are still running: patching and replay tests',
      scenario: 'Orders wait days for a “packed” signal between charging and shipping. You must add a fraud check <em>before</em> charging. Thousands of old orders are mid-flight; they must finish exactly as they started, new orders must get the check, and a bad deploy must be caught before production.',
      why: 'The expensive Temporal bug is not in the code you write today; it is a perfectly reasonable edit that makes yesterday’s histories unreplayable. Patching plus replay tests is the discipline that prevents it.',
      design: [
        '<b>v1</b> is the code as deployed: charge → wait for “packed” → ship.',
        '<b>v2 (step 1)</b> wraps the new activity in <code>patched("fraud-check")</code>. New executions record a marker and run the check; replays of old histories (no marker) skip it.',
        '<b>v3 (step 2)</b> uses <code>deprecate_patch("fraud-check")</code> and runs the check unconditionally, <em>only after</em> every pre-patch execution has finished.',
        'A <b>replay test</b> loads real histories into the new code before every deploy.',
      ],
      tested: [
        '<b>Open v1 history replayed against v2:</b> passes. <b>Against the same change with no patch:</b> <code>NondeterminismError</code> / <code>DeterminismViolationError</code>. The message in TypeScript was “Nondeterminism error: Activity type of scheduled event ‘charge’ does not match activity type of activity command ‘fraudCheck’”.',
        '<b>Real rollout:</b> an order left open under v1 was resumed by a v2 worker. After the signal it called only <code>ship</code> (no fraud check), while a new order called <code>fraud_check, charge, ship</code> (<b>same worker, two code paths</b>). The new order’s history held exactly one marker, named <code>core_patch</code> in both SDKs.',
        '<b>Step 2:</b> the deprecated version replays the new order’s history (with the marker) but <b>rejects the old order’s history</b>. This is why you wait for pre-patch executions to finish before deprecating.',
        '<b>The mistake in production:</b> deploying the unpatched change onto an open order failed its workflow task, status <b>stayed Running</b>; rolling back to v1 let the same execution complete.',
        '<b>A subtler mistake we found:</b> appending a step <em>after</em> <code>charge</code>, exactly where old orders are waiting. Replaying an <b>open</b> old history against it <b>passed</b>, and in production the old order silently ran the new step (after the signal), with no error. Replaying a <b>completed</b> old history caught it.',
      ],
      pitfalls: [
        '<b>Replay only the histories you have.</b> The docs recommend open and closed executions; our subtle case shows an open history that stops at the wait point cannot contradict a step appended right there. Include completed histories that cover the old code path.',
        'The patch ID is a permanent name in history. Don’t reuse it for a different change.',
        'Don’t deprecate or delete a patch while any execution that started before it is still open or inside retention, or those replays fail (docs).',
        'Don’t put the change in an activity “to avoid versioning”: <em>which</em> activities you call, and in what order, is workflow logic.',
        'The docs <b>recommend Worker Versioning</b> and note the pre-2025 experimental method is being removed. We did not test Worker Versioning, only patching.',
      ],
      variations: ['Rename the workflow instead of patching (a <b>cutover</b>): <code>OrderWorkflowV2</code> for new starts, v1 kept until it drains. Simple, but duplicates code.', 'Pin executions to the build they started on with <b>Worker Versioning</b>.', 'Make CI replay the latest 100 histories from <code>client.list_workflows</code> and fail on any error.'],
    },
    /* -------------------------------------------------------------- 3 */
    {
      key: 'import', level: 'Hard', title: 'A nightly import: child workflows plus Continue-As-New',
      scenario: 'Import 100 pages of records. Each page is its own unit of work with its own history and ID, two pages are processed at once, and the parent must run indefinitely without its history growing without bound. If the parent is stopped, you must decide per job whether in-flight pages are killed, cancelled or allowed to finish.',
      why: 'Fan-out and long life are where histories explode. Child workflows keep each page’s events out of the parent; Continue-As-New resets what remains.',
      design: [
        'The parent loops over pages, starting <b>two child workflows at a time</b> with <code>asyncio.gather</code> / <code>Promise.all</code>. Child IDs are deterministic (<code>job-page-N</code>), so a repeated start cannot create duplicates.',
        'After a batch the parent <b>continues as new</b> when <code>is_continue_as_new_suggested()</code> is true <em>or</em> a page count is reached (so the test can see it). The <b>cursor and running total</b> travel in the new run’s input.',
        'It only continues <b>between batches, when no child is in flight</b>, because children don’t carry over.',
        'The <b>Parent Close Policy</b> is an input, set explicitly in both SDKs.',
      ],
      tested: [
        'All 10 pages processed <b>exactly once</b>, total 100. The run we started ended as <b>Continued-As-New</b>, and the last run’s history stayed under 60 events. Every child finished <b>Completed</b>.',
        'The same import with Continue-As-New effectively disabled (1000 pages per run) produced a <b>history more than twice as long</b> as one that continued every 2 pages.',
        '<b>Parent terminated while a page runs:</b> <code>TERMINATE</code> → child Terminated; <code>REQUEST_CANCEL</code> → child Cancelled; <code>ABANDON</code> → child <b>Completed</b>.',
        '<b>Cancelling the parent</b> with the default policy cancelled the running child and the parent ended Cancelled.',
      ],
      pitfalls: [
        '<b>We did not make the server suggest Continue-As-New</b>: the suggestion flag is in the code but the tests triggered the switch by page count. Don’t take that part of the code as proven.',
        'The docs say a single parent <b>should not spawn more than 1,000 children</b>; for more, nest (parent → coordinators → pages) or continue-as-new before reaching it. Children also add more events than activities, so start with activities until you need their own ID, history or lifetime.',
        'Python’s default is <code>TERMINATE</code> (from the SDK signature). A parent that closes will <b>kill</b> running children unless you choose otherwise.',
        '<b>Don’t continue-as-new with children in flight.</b> They are not carried over (docs), so they’d be orphaned or terminated according to the policy.',
        'Don’t continue-as-new from signal or update handlers; let handlers finish first (docs). Keep what you carry forward small: a cursor, not the list.',
      ],
      variations: ['Use <code>id_reuse_policy</code> on children so a re-run of the same job cannot reprocess a completed page (not tested here).', 'Add a <b>query</b> returning the cursor and total so operators can watch progress.', 'Run it on a <b>Schedule</b> with an overlap policy (see the Schedules deep dive when we get there).'],
    },
  ],

  checklist: `
    <h2>Production checklist for workflows</h2>
    <ul>
      <li>☐ No I/O, wall clock, unseeded randomness or threads in workflow code; use activities and the workflow’s time/UUID/random helpers.</li>
      <li>☐ A replay test over real open <em>and</em> closed histories runs in CI and fails the build on any error.</li>
      <li>☐ Changes to commands (timers, activities, children, signals out, markers) go through <code>patched()</code>, Worker Versioning or a cutover.</li>
      <li>☐ Patch IDs are unique and permanent; the deprecate/remove steps are tracked with a date and a retention check.</li>
      <li>☐ Workflow IDs are business keys, and conflict/reuse policies are set deliberately.</li>
      <li>☐ Long-lived workflows continue-as-new from a quiet point (no handlers running, no children in flight) with small state.</li>
      <li>☐ Fan-out uses activities first, children when needed, and stays well under 1,000 children per parent.</li>
      <li>☐ The Parent Close Policy is chosen explicitly for every child.</li>
      <li>☐ Alerts exist for failed workflow tasks (a stuck workflow stays Running).</li>
    </ul>`,

  sources: [
    ['Workflow Definition (determinism, replay, safe changes)', 'https://docs.temporal.io/workflow-definition'],
    ['Workflow ID and Run ID (conflict and reuse policies)', 'https://docs.temporal.io/workflow-execution/workflowid-runid'],
    ['Continue-As-New', 'https://docs.temporal.io/workflow-execution/continue-as-new'],
    ['Event History limits', 'https://docs.temporal.io/workflow-execution/event'],
    ['Child Workflows', 'https://docs.temporal.io/child-workflows'],
    ['Python SDK: Continue-As-New', 'https://docs.temporal.io/develop/python/continue-as-new'],
    ['Python SDK: Versioning (patching)', 'https://docs.temporal.io/develop/python/versioning'],
    ['TypeScript SDK: Versioning (patching)', 'https://docs.temporal.io/develop/typescript/versioning'],
    ['Python SDK: Testing suite (Replayer)', 'https://docs.temporal.io/develop/python/testing-suite'],
    ['TypeScript SDK: Testing suite (replay)', 'https://docs.temporal.io/develop/typescript/testing-suite'],
  ],

  quiz: [
    { q: 'What does a worker do when it needs to resume a workflow it no longer has in memory?', o: ['Loads a saved snapshot of its variables', 'Re-runs the workflow function from the start against the Event History', 'Asks the service for the current state', 'Restarts the workflow from scratch'], a: 1, why: 'State is rebuilt by replay. Commands from the code are compared with history; a mismatch is a non-determinism error.' },
    { q: 'You deploy code that is incompatible with an open execution’s history. What happens to that execution?', o: ['It fails immediately', 'It is terminated', 'Its workflow task fails and it stays Running (blocked) until compatible code is deployed', 'It silently restarts'], a: 2, why: 'We saw the workflow task fail and the status stay Running; rolling the code back let the same execution finish.' },
    { q: 'You need to add an activity before an existing one. Which approach keeps running executions safe?', o: ['Just add it', 'Wrap the new call in patched("id") and keep the old path until old executions finish', 'Move it into an existing activity', 'Restart the worker'], a: 1, why: 'patched() records a marker for new executions; old histories have none and take the old branch.' },
    { q: 'A replay test of an OPEN history passes against code that appends a new activity at the point where the execution is waiting. Is the change safe?', o: ['Yes, replay passed', 'Not necessarily: no later event in that history contradicts it, and in our run the old execution silently ran the new step after its signal', 'No, replay can never pass', 'Yes, because patching is automatic'], a: 1, why: 'Replay only catches what the history can contradict. Replay completed histories too.' },
    { q: 'Your parent workflow is terminated while a child is running, and you set ABANDON. What happens to the child?', o: ['It is terminated', 'It is cancelled', 'It keeps running and, in our test, completed', 'It restarts under the parent'], a: 2, why: 'ABANDON lets children outlive the parent. TERMINATE (the Python default) kills them; REQUEST_CANCEL asks them to cancel.' },
  ],
};
