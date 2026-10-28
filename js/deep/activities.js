'use strict';

/*
 * Deep dive: Activities.
 * Facts come from docs.temporal.io and the SDKs' own type definitions (see `sources`); behaviour the pages
 * don't state was checked by running it. Every use case's code is the file in examples/activities/* that
 * passed its tests (Python 1.34.0, TypeScript 1.24.0, 2026-10-27).
 */
DEEP.activities = {
  title: 'Activities in depth',
  badge: 'deepActivities',
  verified: 'Verified 2026-10-27 · temporalio Python 1.34.0 · @temporalio/* TypeScript 1.24.0 · 13 scenarios pass in each language against a local Temporal dev server (CLI 1.9.1, server 1.32.0)',

  under: `
    <h2>Under the hood</h2>
    <h3>What an activity is, and who retries it</h3>
    <p>An Activity is an ordinary function that does one failure-prone thing. The workflow <em>schedules</em> it; a worker <em>runs</em> it; and <b>the Temporal Service, not your workflow code, performs the retries</b>. That has a nice consequence for history: when we ran an activity that failed three times before succeeding, its history contained exactly one <code>ActivityTaskScheduled</code>, one <code>ActivityTaskStarted</code> (written only when the activity closes, recording the <em>final</em> attempt number, 4) and one <code>ActivityTaskCompleted</code>, and <b>no <code>ActivityTaskFailed</code> events</b>. Retrying is free as far as history size is concerned.</p>

    <h3>The retry policy</h3>
    <table>
      <tr><th>Field</th><th>Default</th><th>Notes</th></tr>
      <tr><td>Initial interval</td><td>1 second</td><td>The wait before the first retry.</td></tr>
      <tr><td>Backoff coefficient</td><td>2.0</td><td>1.0 keeps every wait at the initial interval.</td></tr>
      <tr><td>Maximum interval</td><td>100 × initial interval</td><td>The wait before retry <em>n</em> is the smaller of <code>initial × coefficient<sup>n</sup></code> and this cap.</td></tr>
      <tr><td>Maximum attempts</td><td>Unlimited</td><td><code>0</code> also means unlimited; <code>1</code> means a single attempt, no retries; a negative value is an error.</td></tr>
      <tr><td>Non-retryable error types</td><td>none</td><td>Matched against the <code>type</code> of the thrown <code>ApplicationError</code>/<code>ApplicationFailure</code>.</td></tr>
    </table>
    <ul>
      <li><b>Activities retry by default; workflows don’t.</b> A plain exception from an activity (<code>ConnectionError</code>, a bug, anything) is retried with backoff until it succeeds or a timeout/limit stops it. <b>With the default policy that can be forever.</b></li>
      <li>We measured the waits: with <code>initial=1s, coefficient=2</code> the gaps between attempts were <b>1 s, 2 s, 4 s</b> (and 1.5 s → 1.5 s, 3 s).</li>
      <li><b>Observed on server 1.32.0:</b> retry delays below one second were <b>rounded up to one second</b> (initial intervals of 100 ms and 500 ms both produced 1 s gaps). Treat 1 s as the practical minimum. This isn’t stated on the pages we read, so re-check on your own server version.</li>
      <li><b>Stop retrying on purpose:</b> throw an <code>ApplicationError</code> with <code>non_retryable=True</code> (Python) / <code>ApplicationFailure.create({ nonRetryable: true })</code> (TypeScript), or list its <code>type</code> in <code>non_retryable_error_types</code>.</li>
      <li><b>Choose the next wait yourself:</b> <code>next_retry_delay</code> / <code>nextRetryDelay</code> on the thrown failure <em>replaces</em> the policy’s interval for that retry (ideal for HTTP 429 <code>Retry-After</code>).</li>
      <li>Bound retries with a <b>timeout</b>, not an attempt count: the docs recommend Schedule-To-Close over Maximum Attempts for limiting total retry time.</li>
    </ul>

    <h3>The four timeouts</h3>
    <table>
      <tr><th>Timeout</th><th>Measures</th><th>Default</th><th>Retried?</th></tr>
      <tr><td><b>Start-To-Close</b></td><td>One attempt, from start to finish</td><td>none: <b>you must set this or Schedule-To-Close</b>, or the service rejects the activity</td><td>Yes. It restarts per attempt. We saw an attempt that hung past 1 s time out and the next attempt succeed.</td></tr>
      <tr><td><b>Schedule-To-Close</b></td><td>The whole activity, <em>including every retry</em></td><td>∞</td><td>Enforced once per activity. It caps total duration.</td></tr>
      <tr><td><b>Schedule-To-Start</b></td><td>Waiting in the task queue for a worker</td><td>∞</td><td><b>Never retried</b>, whatever the retry policy says. We confirmed it: a 5-attempt policy failed after ~1 s, not 5.</td></tr>
      <tr><td><b>Heartbeat</b></td><td>Gap between heartbeats</td><td><code>0s</code> = disabled</td><td>Yes, per the retry policy. Capped at Start-To-Close.</td></tr>
    </table>
    <p>The docs recommend <b>always setting Start-To-Close</b> (the service relies on it to retry after a worker crashes silently) and monitoring the <code>temporal_activity_schedule_to_start_latency</code> metric instead of setting Schedule-To-Start in most cases.</p>

    <h3>At-least-once: make activities idempotent</h3>
    <p>If a worker dies, or an attempt times out, after the side effect happened but before the result was reported, the activity runs again. So every activity <b>must be safe to run twice</b>. The standard tool is an <b>idempotency key</b> sent to the downstream system. The docs derive it from the activity info: <code>workflow_run_id</code> + <code>activity_id</code>. It is stable across retries of one activity and different for every other. (It changes if the workflow itself is re-run or continued-as-new; use a business key like the order ID when you need that scope.)</p>

    <h3>Heartbeats: liveness, progress and cancellation in one call</h3>
    <ul>
      <li><b>Liveness:</b> with a <code>heartbeat_timeout</code>, a silent worker is detected after that interval instead of after the (much longer) Start-To-Close.</li>
      <li><b>Progress:</b> details passed to <code>heartbeat(...)</code> are handed to the <em>next attempt</em> (<code>info.heartbeat_details</code> / <code>activityInfo().heartbeatDetails</code>), unless the worker died before delivering them.</li>
      <li><b>Cancellation:</b> “Activity Cancellations are delivered to Activities from the Temporal Service when they Heartbeat.” An activity that doesn’t heartbeat can’t be cancelled while it runs. We proved both halves: the same workflow-cancel reached the heartbeating activity but never the silent one.</li>
      <li><b>Throttling:</b> heartbeats are batched, roughly every 0.8 × the heartbeat timeout (docs), so progress and cancellation can be <em>delayed</em>. We tripped over this ourselves: with a 5 s heartbeat timeout our 2.5 s activity finished before it ever saw the cancel.</li>
    </ul>

    <h3>Cancellation, and the type you choose</h3>
    <p>Cancellation arrives in the activity as <code>asyncio.CancelledError</code> at the next <code>await</code> (Python), or via <code>cancelled()</code> / <code>Context.current().cancellationSignal</code> / <code>Context.current().sleep()</code> (TypeScript, which must opt in; a plain pending promise never notices). The workflow-side <code>cancellation_type</code> decides what the <em>workflow</em> does meanwhile:</p>
    <table>
      <tr><th>Type</th><th>Meaning (from the SDK definitions)</th></tr>
      <tr><td><code>TRY_CANCEL</code></td><td>Request cancellation and report it to the caller immediately. No guarantee it is delivered: the activity may even finish successfully while the workflow believes it was cancelled.</td></tr>
      <tr><td><code>WAIT_CANCELLATION_COMPLETED</code></td><td>Request cancellation and <b>wait</b> for the activity to finish (success, failure or cancelled). We used it so cleanup ran <em>before</em> the workflow ended.</td></tr>
      <tr><td><code>ABANDON</code></td><td>Don’t even tell the activity; report cancellation immediately.</td></tr>
    </table>
    <div class="callout warn"><b class="t">The default differs by SDK</b>TypeScript’s default is <code>WAIT_CANCELLATION_COMPLETED</code>; Python’s is <code>TRY_CANCEL</code>. Set it explicitly. Also, terminating a workflow always cancels its outstanding activities regardless of the type.</div>

    <h3>Protect downstream systems from the worker side</h3>
    <ul>
      <li><b>Concurrency:</b> <code>max_concurrent_activities</code> / <code>maxConcurrentActivityTaskExecutions</code> (TypeScript default 100) caps parallel activities on one worker.</li>
      <li><b>Rate:</b> <code>max_activities_per_second</code> / <code>maxActivitiesPerSecond</code> stops a worker from <em>polling</em> for more work than it may start. We measured 40 quick calls: <b>0.06 s unlimited vs 1.83 s at 20/s</b>.</li>
      <li><b>Queue-wide rate:</b> <code>max_task_queue_activities_per_second</code> is enforced server-side per task queue. If workers on the same queue set different values they “thrash, with the last poller winning”.</li>
      <li>Both worker limits are per <b>worker process</b>; run <em>N</em> workers and the downstream sees up to <em>N ×</em> the limit.</li>
    </ul>

    <h3>Two alternatives to the regular activity</h3>
    <ul>
      <li><b>Local activities</b> run inside the workflow worker, with no task-queue round trip and fewer history events (we saw a <code>MarkerRecorded</code> event and <b>no</b> <code>ActivityTaskScheduled</code>). The docs limit them to short (seconds), idempotent work: no heartbeats, no rate limiting, signals aren’t processed while they run, and regular activities remain the recommended default.</li>
      <li><b>Async completion</b> lets an activity hand off and finish later from elsewhere (a webhook, a human): the activity saves its <b>task token</b> and signals “I’ll complete later” (<code>activity.raise_complete_async()</code> / <code>throw new CompleteAsyncError()</code>); another process finishes it with <code>complete</code> or <code>fail</code> on an async-activity handle. We tested both outcomes in both SDKs, and (in Python) that its Start-To-Close timeout still applies while it waits.</li>
    </ul>`,

  cases: [
    /* -------------------------------------------------------------- 1 */
    {
      key: 'payments', level: 'Medium', title: 'Charging a card: retries, idempotency and business outcomes',
      scenario: 'Checkout must charge a card through a flaky payment API. Network blips should be retried quietly; a rate-limit response should be obeyed; a declined card must stop immediately and return a clean “declined”; and under no circumstances may the customer be charged twice.',
      why: 'Everything checkout needs from the activity layer is configuration, not code: backoff, per-attempt timeouts, non-retryable failures, a server-provided delay. The only thing you write is the idempotency discipline.',
      design: [
        'The activity builds an <b>idempotency key</b> from <code>workflow_run_id + activity_id</code> and sends it with the charge. The (fake) provider returns the <em>same</em> charge for the same key.',
        'It translates provider outcomes into Temporal outcomes: <b>declined → non-retryable <code>ApplicationError</code></b> (type <code>CardDeclined</code>); <b>429 → <code>next_retry_delay</code></b> from the <code>Retry-After</code>; <b>anything else escapes as a plain exception</b> and is retried with backoff.',
        'The workflow sets a <b>per-attempt Start-To-Close</b> and a retry policy (1 s initial, ×2, capped at 30 s, <code>maximum_attempts</code> configurable).',
        'The workflow turns a decline into a <b>return value</b> (<code>declined</code>), a business outcome, while exhausted retries are allowed to <b>fail the workflow</b>.',
      ],
      tested: [
        'Three transient failures then success: the waits between attempts are <b>1 s, 2 s, 4 s</b>, and the history shows no failed-attempt events.',
        '<b>Lost response:</b> the provider charged the card but the connection died before the reply. The retry sent the same key and got the same charge: <b>exactly one charge exists</b>.',
        'A declined card is attempted <b>once</b> and the workflow returns <code>declined</code>.',
        'A provider-supplied 3 s delay <b>overrides</b> the 1 s backoff.',
        'An attempt that exceeds Start-To-Close (1 s) times out and is retried successfully.',
        'With <code>maximum_attempts=3</code> and a permanently failing provider, the workflow fails after exactly 3 calls, with the connection error as the root cause.',
      ],
      pitfalls: [
        '<b>Sub-second intervals don’t work:</b> on our server 100 ms and 500 ms initial intervals both became 1 s. Use whole seconds.',
        'Any plain exception is retried, <b>including bugs</b>. With the default policy a <code>TypeError</code> retries forever. Set <code>maximum_attempts</code>, a Schedule-To-Close, or non-retryable types for programming errors.',
        'Don’t use <code>maximum_attempts</code> as a time limit. Use Schedule-To-Close for “give up after 10 minutes”.',
        'Start-To-Close times out the <em>wait</em>, not necessarily the code: a hung attempt may still finish later. (In our TypeScript run the log showed “Activity not found on completion”: a late zombie attempt reporting to an activity that had already moved on.) Idempotency is what makes that harmless.',
        'The key must come from stable IDs. <code>run_id + activity_id</code> is stable across retries of one activity but not across workflow re-runs; use the order ID if the same payment must be deduplicated across runs.',
      ],
      variations: ['Mark more error types non-retryable via <code>non_retryable_error_types</code> in the policy (e.g. <code>InvalidCardFormat</code>).', 'Add a Schedule-To-Close of 10 minutes as the overall deadline.', 'Compensate a failed checkout with a refund activity (see the Saga pattern in module 9).'],
    },
    /* -------------------------------------------------------------- 2 */
    {
      key: 'export', level: 'Hard', title: 'A long export: heartbeats, resume-after-failure and graceful cancellation',
      scenario: 'A customer data export writes thousands of chunks over ten minutes. If the worker wedges, you want to know in seconds, and the retry must pick up where the last attempt stopped instead of starting over. If the customer cancels, the export must stop promptly and release its lock before the workflow reports “cancelled”.',
      why: 'Heartbeats turn a 10-minute black box into an observable, resumable, cancellable job. Without them a stuck worker looks identical to a slow one until the full Start-To-Close expires.',
      design: [
        'Start-To-Close is generous (10 minutes) because it limits <b>one attempt</b>. <b>Heartbeat timeout is short (1 s)</b>: that is what detects a wedged worker.',
        'After <b>each chunk is written</b> the activity calls <code>heartbeat(i)</code>: “chunk <em>i</em> is done”.',
        'On every attempt the activity reads the previous <b>heartbeat details</b> and starts at <code>last_done + 1</code>.',
        'Chunk writes are <b>idempotent</b>: the chunk after the last heartbeat may be written twice (once by a dead attempt, once by the retry).',
        'Cancellation: Python catches <code>asyncio.CancelledError</code>; TypeScript races each write against <code>cancelled()</code> so the pending promise doesn’t hide the cancellation. Both <b>release the lock, then re-raise</b>.',
        'The workflow uses <code>WAIT_CANCELLATION_COMPLETED</code> so it only finishes <em>after</em> that cleanup.',
      ],
      tested: [
        'An attempt wedges at chunk 5 and stops heartbeating. It is declared dead by the <b>1 s heartbeat timeout</b> (not after 10 minutes). Attempt 2 <b>resumes at chunk 5</b>, finishes all 10 chunks, and <b>every chunk was written exactly once</b>.',
        'Cancelling the workflow mid-export reaches the activity on its next heartbeat; <b>the lock is released first</b>, then the workflow ends <code>CANCELLED</code>, with the export stopped partway.',
        '<b>Doc claim confirmed:</b> given the same cancel, a heartbeating activity received it and a non-heartbeating one never did.',
      ],
      pitfalls: [
        'Heartbeat <b>after</b> the work for item <em>i</em>, so the saved details only ever claim finished work.',
        'Heartbeats are throttled (~0.8 × the heartbeat timeout). A heartbeat timeout of 5 s means cancellation/progress can lag by seconds. Keep the timeout short for responsive cancellation.',
        'Heartbeat details are lost if the worker crashed before delivering them, so resumption must tolerate re-doing the last unit of work.',
        'Swallowing the cancellation (catching it and carrying on) is legal but then the activity ignores the cancel. Clean up and re-raise.',
        'TypeScript activities must opt in to observing cancellation (<code>cancelled()</code>, <code>cancellationSignal</code> or <code>Context.current().sleep</code>).',
        'The default <code>cancellation_type</code> differs between SDKs. Set it explicitly.',
        'Keep heartbeat details small. They’re stored by the service on every (non-throttled) beat.',
      ],
      variations: ['Heartbeat a richer progress record (offset + checksum) and verify it on resume.', 'Surface heartbeat progress to a dashboard.', 'Split the export into chunk-range child activities if one activity becomes too coarse.'],
    },
    /* -------------------------------------------------------------- 3 */
    {
      key: 'fanout', level: 'Hard', title: 'Syncing 10,000 profiles from a rate-limited third-party API',
      scenario: 'A nightly sync fetches one profile per user from a partner API that tolerates only a few concurrent callers and asks you to slow down when busy. Some users no longer exist, a few requests get a 429, and one bad user must not lose the other results.',
      why: 'Fan-out is just “start many activities and gather them”. The protection for the partner lives where it belongs: in worker limits, retry policy and failure classification, not in hand-rolled semaphores in your workflow.',
      design: [
        '<b>Workflow:</b> start one activity per user and gather them with <b>partial-failure semantics</b> (<code>asyncio.gather(..., return_exceptions=True)</code> / <code>Promise.allSettled</code>). Classify each result: profile, <code>NotFound</code> (missing), or other failure.',
        '<b>Activity:</b> maps <b>404 → non-retryable <code>NotFound</code></b> and <b>429 → <code>next_retry_delay</code></b> taken from the API’s own hint; transient errors retry with backoff.',
        '<b>Worker:</b> <code>max_concurrent_activities=5</code> keeps the API under its concurrency limit; <code>max_activities_per_second</code> keeps it under its rate limit. The workflow can start 10,000 activities without hammering anyone.',
        '<b>Backlog protection:</b> a Schedule-To-Start timeout makes a saturated or absent worker fleet fail fast instead of silently queueing (it is never retried).',
        '<b>Scale:</b> each activity adds ~3 history events and a history is limited (hard cap 51,200 events / 50 MB), so process very large syncs in batches or with child workflows.',
      ],
      tested: [
        '38 users (2 missing, 3 throttled once): 36 profiles, <code>missing = [missing1, missing2]</code>, no other failures; the API never saw more than <b>5 concurrent</b> calls (and more than 1, so it was parallel); the 3 throttled ids cost exactly 3 extra calls and the missing ones were <b>not</b> retried.',
        '40 calls with a per-second cap of 20: <b>1.83 s</b> versus <b>0.06 s</b> without the cap.',
        '<b>Doc claim confirmed:</b> a Schedule-To-Start timeout on a queue nobody polls failed after ~1 s with a <code>SCHEDULE_TO_START</code> timeout, not 5 retried attempts.',
      ],
      pitfalls: [
        'Worker limits are <b>per worker process</b>. Ten workers with <code>max_concurrent_activities=5</code> allow 50 concurrent calls. Use the task-queue-level rate limit (or size your fleet) when the API limit is global; but don’t give different values to workers on the same queue (“thrash, last poller wins”).',
        'Without <code>return_exceptions</code> / <code>allSettled</code>, the first failure aborts the whole gather and you lose every other result.',
        'Non-retryable only works if you <b>classify</b> errors: an unclassified 404 would be retried until maximum attempts.',
        'Use the API’s <code>Retry-After</code> via <code>next_retry_delay</code> instead of guessing with backoff. (Remember the 1 s floor.)',
        'Don’t put 10,000 activities in one workflow run: batch them (e.g. 500 at a time) or use child workflows.',
        'Heavy downstream limits belong on <b>dedicated task queues</b>, so one noisy integration can’t starve everything else.',
      ],
      variations: ['Per-partner task queues with their own worker limits.', 'Process users in batches of 500 with Continue-As-New between batches.', 'Add an overall Schedule-To-Close so the whole sync gives up after an hour.'],
    },
  ],

  checklist: `
    <h2>Production checklist for activities</h2>
    <ul>
      <li>☐ Start-To-Close (per attempt) is always set; Schedule-To-Close bounds total retry time where it matters.</li>
      <li>☐ The retry policy is explicit: no accidental “retry bugs forever”. Non-retryable types or a maximum are set.</li>
      <li>☐ Business outcomes (declined, not found) are non-retryable <code>ApplicationError</code>s handled in the workflow.</li>
      <li>☐ Every side effect is idempotent (key from stable IDs); activities are safe to run twice.</li>
      <li>☐ Server hints (<code>Retry-After</code>) are honoured with <code>next_retry_delay</code>.</li>
      <li>☐ Long activities heartbeat after each unit of work, have a short heartbeat timeout, and resume from heartbeat details.</li>
      <li>☐ Cancellation is handled (cleanup, then re-raise) and <code>cancellation_type</code> is chosen explicitly.</li>
      <li>☐ Worker concurrency and rate limits match what downstream systems tolerate (per process!).</li>
      <li>☐ Retry intervals are whole seconds (≥ 1 s).</li>
      <li>☐ Fan-out uses partial-failure gathering and a bounded batch size; history growth is considered.</li>
      <li>☐ Schedule-To-Start latency is monitored (<code>temporal_activity_schedule_to_start_latency</code>).</li>
    </ul>`,

  sources: [
    ['Retry Policies', 'https://docs.temporal.io/encyclopedia/retry-policies'],
    ['Detecting Activity failures (timeouts and heartbeats)', 'https://docs.temporal.io/encyclopedia/detecting-activity-failures'],
    ['Python SDK: failure detection and Activity retries', 'https://docs.temporal.io/develop/python/failure-detection'],
    ['Python SDK: Activity timeouts and heartbeats', 'https://docs.temporal.io/develop/python/activities/timeouts'],
    ['TypeScript SDK: Activity timeouts and heartbeats', 'https://docs.temporal.io/develop/typescript/activities/timeouts'],
    ['TypeScript SDK: failure detection', 'https://docs.temporal.io/develop/typescript/failure-detection'],
    ['Local Activities', 'https://docs.temporal.io/local-activity'],
    ['Event reference', 'https://docs.temporal.io/references/events'],
    ['Temporal Cloud system limits', 'https://docs.temporal.io/cloud/limits'],
  ],

  quiz: [
    { q: 'You set no retry policy and your activity throws a plain exception. What happens?', o: ['The workflow fails immediately', 'It is retried with exponential backoff (1 s, 2 s, 4 s…, capped at 100 s) until it succeeds or a timeout stops it', 'It is retried exactly 3 times', 'It is not retried unless you add a retry policy'], a: 1, why: 'Activities retry by default with unlimited attempts, which is why you should set limits and classify non-retryable errors.' },
    { q: 'A payment call succeeded, but the connection died before the reply, so Temporal retried. Why was the customer charged only once?', o: ['Temporal de-duplicates side effects', 'The idempotency key (run ID + activity ID) was identical on every attempt and the provider returned the same charge', 'Retries never happen after success', 'The second attempt was skipped'], a: 1, why: 'Activities are at-least-once. Idempotency keys are what make repeats harmless; the key must be stable across retries.' },
    { q: 'Which activity timeout is never retried, whatever the retry policy says?', o: ['Start-To-Close', 'Heartbeat', 'Schedule-To-Start', 'Schedule-To-Close'], a: 2, why: 'A Schedule-To-Start timeout is non-retryable by design. We confirmed a 5-attempt policy failed after one timeout.' },
    { q: 'A workflow is cancelled while an activity that never heartbeats is running. What does the activity learn?', o: ['It is cancelled immediately', 'Nothing while it runs: cancellation is delivered only when the activity heartbeats', 'It receives a SIGTERM', 'It is terminated by the worker'], a: 1, why: 'The docs state it and we proved it: the same cancel reached the heartbeating activity but never the silent one.' },
    { q: 'A partner API replies 429 with “Retry-After: 3”. What is the idiomatic way to respect it?', o: ['Sleep for 3 s inside the activity', 'Raise an ApplicationError with next_retry_delay of 3 s', 'Set maximum_attempts to 3', 'Mark the error non-retryable'], a: 1, why: 'next_retry_delay replaces the policy’s interval for that retry, so the wait is chosen by the server’s hint and not held in a worker slot.' },
  ],
};
