'use strict';

/*
 * Deep dive: Workers & Task Queues.
 * Facts come from docs.temporal.io (see `sources`); behaviour the pages don't state was checked by running it.
 * Every use case's code is the file in examples/workers/* that passed its tests
 * (Python 1.34.0, TypeScript 1.24.0, 2026-10-28).
 */
DEEP.workers = {
  title: 'Workers & Task Queues in depth',
  badge: 'deepWorkers',
  verified: 'Verified 2026-10-28 · temporalio Python 1.34.0 · @temporalio/* TypeScript 1.24.0 · 9 scenarios pass in Python, 8 in TypeScript, against a local Temporal dev server (CLI 1.9.1, server 1.32.0)',

  under: `
    <h2>Under the hood</h2>
    <h3>Worker Program, Worker Process, Worker Entity</h3>
    <p>The docs use three terms. A <b>Worker Program</b> is your code; a <b>Worker Process</b> is the OS process running it; a <b>Worker Entity</b> is one poller-plus-executor inside that process, and <b>it polls exactly one Task Queue</b> (and hosts a Workflow Worker, an Activity Worker or both). A process that needs several queues runs several Worker Entities. The service never runs your code and workers only make <em>outbound</em> connections. Workers are stateless: a workflow that is blocked can be evicted from a worker at any time and rebuilt from history by any other.</p>

    <h3>Task Queues</h3>
    <ul>
      <li>A queue needs <b>no registration</b>: it exists when a workflow or activity is started on it or a worker polls it. A name creates a Workflow queue, an Activity queue (and a Nexus queue) sharing that name.</li>
      <li>You set the name in five places: when starting a workflow, when creating a worker, when starting an activity, when starting a child workflow, and when creating a Nexus endpoint. <b>An activity or child that sets no queue inherits its parent’s.</b></li>
      <li><b>Every worker on a queue must register the same workflow and activity types.</b> The queue does not route by type, so a task for an unregistered type fails on the worker that receives it (use case 1 shows what that looks like).</li>
      <li>Workers poll only when they have spare capacity. That is the built-in <b>flow control</b>: extra tasks wait in the queue (workflow and activity tasks persist there until a worker recovers; query and Nexus tasks do not).</li>
      <li>Each queue has <b>4 partitions by default</b>. Within one partition delivery is almost always FIFO; across partitions it is not, and ordering applies to individual tasks only, never to events inside a workflow.</li>
    </ul>

    <h3>Capacity: slots, pollers, cache</h3>
    <p>A <b>task slot</b> is the capacity to run one task at a time. Pollers long-poll the queue and hand tasks to free slots. The docs’ defaults:</p>
    <table>
      <tr><th>Setting</th><th>Python</th><th>TypeScript</th></tr>
      <tr><td>Concurrent workflow tasks</td><td>100</td><td>40</td></tr>
      <tr><td>Concurrent activities</td><td>100</td><td>100</td></tr>
      <tr><td>Workflow / activity task pollers</td><td>5 / 5</td><td>10 / 10</td></tr>
      <tr><td>Sticky workflow cache</td><td>1,000</td><td>dynamic (about 2,000 for 4 GiB of RAM, per the docs)</td></tr>
    </table>
    <p>Slots come from a <b>slot supplier</b>: fixed-size, resource-based (target CPU and memory) or custom, assigned through a <em>tuner</em>. The docs warn that resource-based targets can still be exceeded, that tuners <b>supersede</b> the <code>maxConcurrent…</code> options (using both is an error at startup) and that they recommend <b>poller autoscaling</b> for most uses. We tested the plain <code>max_concurrent_activities</code> and cache options, not tuners or autoscaling.</p>

    <h3>Shutting down</h3>
    <p>On shutdown a worker stops polling and lets in-flight tasks finish for up to the <b>grace time</b> (Python <code>graceful_shutdown_timeout</code>, TypeScript <code>shutdownGraceTime</code>). Past that, running activities are cancelled; whatever never reports back is rescheduled when an activity timeout fires. In TypeScript the <code>shutdownSignals</code> option (<code>SIGINT</code>, <code>SIGTERM</code>, <code>SIGQUIT</code>, <code>SIGUSR2</code>) starts this sequence.</p>

    <h3>Identity</h3>
    <p>The default worker identity is <code>pid@hostname</code>. In Docker the PID is always 1, so set an identity that names the task or pod instead.</p>
  `,

  cases: [
    /* -------------------------------------------------------------- 1 */
    {
      key: 'routing', level: 'Medium', title: 'Routing work with task queues: GPU machines and file affinity',
      scenario: 'A media pipeline downloads a file, processes it and uploads it, then renders a preview. The first three steps touch a local file, so they must run on the <em>same machine</em>. The render needs a GPU, which only some machines have.',
      why: 'Task queues are Temporal’s routing layer. A queue per capability and a queue per host cover most “this work must run over there” requirements with no new infrastructure.',
      design: [
        '<b>Capability queue:</b> <code>media-gpu</code> is polled only by GPU machines. The workflow starts the render activity with <code>task_queue="media-gpu"</code>.',
        '<b>Host affinity (the “worker-specific queue” pattern):</b> every host polls the shared <code>media</code> queue for one tiny activity, <code>get_host_queue</code>, which returns <em>its own</em> unique queue name. The workflow then runs download, process and upload on that queue.',
        'Each host is therefore <b>two Worker Entities</b>: one on the shared queue, one on its own.',
        'The host steps set a short <b>Schedule-To-Start timeout</b> so that a host that disappears after answering the lookup fails fast, and the workflow <b>picks another host</b> and starts over.',
      ],
      tested: [
        '8 concurrent jobs on 2 hosts: every job’s download, process and upload ran on <b>one</b> host (each host’s log held only whole jobs) and the renders came from the GPU queue.',
        '<b>Dead host:</b> a “ghost” host answered lookups but had no worker on its own queue. Six jobs all completed on the good host and the ghost ran no file step.',
        '<b>Unregistered activity</b> (Python): asking the shared queue for <code>render_on_gpu</code>, which its workers don’t register, did not fail the workflow. Each attempt failed with <code>NotFoundError: Activity function … is not registered on this worker, available activities: get_host_queue</code> and was retried until the 4 s Schedule-To-Close deadline (<b>3.1 s</b> with the default backoff), then surfaced as an activity failure.',
      ],
      pitfalls: [
        '<b>One runtime refuses two workers with the same task types on one queue.</b> Both SDKs raised “Registration of multiple workers with overlapping worker task types on the same namespace, task queue, and deployment build ID not allowed”. Real hosts are separate processes, so the Python test gives each host its own <code>Runtime</code> and the TypeScript test spawns each host as a child process.',
        '<b>Affinity creates a single point of failure.</b> If the chosen host dies, its local file is gone; the workflow has to restart the whole sequence (here: re-download), not retry one step. The docs say host routing is logic <em>you</em> build; there is no built-in mechanism.',
        'Every extra queue is something to deploy and monitor. The docs mention a <b>Worker Session</b> API (SDK-dependent) and Task Queue Priority as alternatives; we did not test either.',
        'A typo in a task queue name is not an error: nothing polls it, and the task just waits. The Schedule-To-Start timeout is what turns that into something you notice.',
      ],
      variations: ['One queue per priority, or Task Queue Priority within a queue (docs).', 'A new queue for a backward-incompatible activity change, as an alternative to Worker Versioning (docs).', 'One queue per worker process when activities share an in-memory dataset (docs).'],
    },
    /* -------------------------------------------------------------- 2 */
    {
      key: 'shutdown', level: 'Hard', title: 'Deploys and crashes: graceful shutdown, grace periods and a killed worker',
      scenario: 'A 2–6 second render activity runs while you deploy, and occasionally a worker is OOM-killed. A deploy should not repeat work that was nearly done, and a crash should cost seconds, not minutes.',
      why: 'Workers are meant to be disposable. Whether a restart is invisible or costs a retry comes down to three settings: the grace period, heartbeats, and the activity’s timeouts.',
      design: [
        'The activity writes a <b>marker file per attempt</b> (with its process ID) so the test can see exactly which attempt ran where.',
        'It <b>heartbeats every 200 ms</b>; the workflow sets a <b>2 s heartbeat timeout</b> and a 60 s Start-To-Close.',
        'On cancellation it records <b>why</b> (Python <code>activity.is_worker_shutdown()</code>; TypeScript the cancellation signal’s reason), then re-raises.',
        'The “crash” is a real <b>OS process killed with SIGKILL</b>; the survivor is an ordinary worker started afterwards.',
      ],
      tested: [
        '<b>Long grace (10 s):</b> shutdown <b>waited</b> for the 2 s activity and it finished on <b>attempt 1</b>, with no cancellation recorded (both SDKs).',
        '<b>Short grace (0.5 s):</b> the 3 s activity was cancelled. Python reported <code>is_worker_shutdown() = true</code>; TypeScript reported the reason <code>WORKER_SHUTDOWN</code>. A second worker then ran <b>attempt 2</b> to completion.',
        '<b>SIGKILL mid-activity:</b> attempt 2 started on a different process <b>2.9 s</b> after the kill in Python and <b>2.9 s and 3.3 s</b> in two TypeScript runs, consistent with the 2 s heartbeat timeout plus the 1 s retry delay.',
      ],
      pitfalls: [
        '<b>A grace period shorter than your activities turns every deploy into a retry.</b> Set it from the longest activity you are willing to wait for, and make sure your orchestrator (Kubernetes <code>terminationGracePeriodSeconds</code>, for example) allows at least that long.',
        '<b>Without heartbeats a dead worker is only noticed at Start-To-Close</b> (60 s here). We did not run that comparison; this follows from the timeout semantics in the docs.',
        'A cancelled activity must be safe to start again from scratch, or must resume from its heartbeat details (see the Activities deep dive). Attempt 2 above began at the beginning.',
        'We measured a clean SIGKILL of one idle-ish process. We did not test network partitions or a whole node disappearing, where sticky-queue timeouts may add delay for workflow tasks.',
      ],
      variations: ['Run workflow and activity workers in separate processes so activity deploys never evict workflow state.', 'Use <code>shutdownForceTime</code> (TypeScript) as a hard upper bound.', 'Roll deployments with Worker Versioning (docs), not tested here.'],
    },
    /* -------------------------------------------------------------- 3 */
    {
      key: 'tuning', level: 'Hard', title: 'Sizing a worker from its own metrics: slots, latency and the sticky cache',
      scenario: 'Throughput is lower than expected and some workflows feel slow. Is the worker out of activity slots, or is it thrashing its workflow cache? Find out from the worker’s metrics instead of guessing.',
      why: 'Every limit in a worker is observable. A handful of metrics tell you which knob to turn, and you can reproduce each symptom on purpose to learn what it looks like.',
      design: [
        'Create the SDK <b>runtime with a Prometheus endpoint before creating the client and workers</b> (Python <code>Runtime(telemetry=…PrometheusConfig)</code>; TypeScript <code>Runtime.install</code>) and read <code>/metrics</code>.',
        '<b>Symptom A, too few activity slots:</b> 6 one-second activities on a worker with <code>max_concurrent_activities=2</code> versus 10.',
        '<b>Symptom B, sticky cache too small:</b> 4 workflows each waiting for 2 signals, poked round-robin, on a cache of 1 (Python) or 2 (TypeScript) versus 100.',
        'Compare per-task-queue values; the cache and slot settings are the only difference.',
      ],
      tested: [
        '<b>Metric names exist</b> (docs list them): <code>temporal_worker_task_slots_available</code>, <code>temporal_worker_task_slots_used</code>, <code>temporal_num_pollers</code>, <code>temporal_activity_schedule_to_start_latency</code>, <code>temporal_workflow_task_execution_latency</code>, <code>temporal_sticky_cache_size</code>, <code>temporal_sticky_cache_hit</code> (the miss counter appears once a miss happens).',
        '<b>Slots:</b> with 2 slots the observed peak concurrency was exactly 2, <code>slots_available</code> for the activity worker read <b>0</b> mid-run, and the average Schedule-To-Start latency was about <b>1,000 ms</b> in both SDKs. With 10 slots peak concurrency was 6 and the average was <b>~0–2 ms</b>. <b>The latency metric is in milliseconds.</b>',
        '<b>Sticky cache:</b> Python with cache=1: <b>8 misses, 0 hits</b>; cache=100: <b>0 misses, 8 hits</b>. TypeScript with cache=2: 6 misses, 2 hits; cache=100: 0 misses, 8 hits. <b>All workflows returned correct results either way</b>: a miss means a replay, not a bug.',
      ],
      pitfalls: [
        '<b>Metrics belong to the runtime.</b> Create the runtime first; a client created earlier won’t report to it (Python needs <code>runtime=</code> on the client).',
        '<b>A cache miss is expected after a restart</b> and costs a history fetch plus replay. Sustained misses with enough memory are the signal to raise the cache; sustained forced evictions suggest memory pressure (docs).',
        '<b>Don’t raise slots blindly.</b> Slots multiply by process count, and downstream systems feel it; use <code>max_activities_per_second</code> for protection (Activities deep dive).',
        'TypeScript refuses a cache below 2 when caching is on (its option docs say so), so the two SDKs’ “tiny cache” experiments use 1 and 2.',
        'Defaults differ by SDK (table above). Don’t carry numbers over between languages.',
        'These were single-worker experiments on a laptop. The absolute numbers are meaningless; the shapes (zero free slots, ~1 s latency, hit/miss flip) are the point.',
      ],
      variations: ['Alert on <code>schedule_to_start_latency</code> and slots-available, not on CPU alone.', 'Try a resource-based tuner or poller autoscaling (docs, not tested).', 'Read worker heartbeats in the UI (needs server 1.30+ per the docs).'],
    },
  ],

  checklist: `
    <h2>Production checklist for workers</h2>
    <ul>
      <li>☐ Every worker on a task queue registers the same workflow and activity types.</li>
      <li>☐ Queue names live in one shared constant; a typo means silence, not an error.</li>
      <li>☐ Activities that must wait for a specific queue or host set a Schedule-To-Start timeout.</li>
      <li>☐ The grace period covers your longest in-flight activity, and the orchestrator’s kill timeout is longer than the grace period.</li>
      <li>☐ Long activities heartbeat and set a heartbeat timeout so a dead worker is noticed in seconds.</li>
      <li>☐ Workflow and activity workers are separated if their load or deploy cadence differs.</li>
      <li>☐ Metrics are exported: slots available, Schedule-To-Start latency, sticky cache hit/miss, pollers.</li>
      <li>☐ Concurrency limits are chosen per process and checked against downstream capacity.</li>
      <li>☐ Worker identity names the pod/task, not “1@host”.</li>
      <li>☐ Workflow code changes are rolled out with patching or Worker Versioning (see Workflows).</li>
    </ul>`,

  sources: [
    ['Workers', 'https://docs.temporal.io/workers'],
    ['Task Queues', 'https://docs.temporal.io/task-queue'],
    ['Task Routing', 'https://docs.temporal.io/task-routing'],
    ['Worker performance', 'https://docs.temporal.io/develop/worker-performance'],
    ['Worker tuning reference (defaults and metrics)', 'https://docs.temporal.io/develop/worker-tuning-reference'],
    ['Python SDK: Run a Worker', 'https://docs.temporal.io/develop/python/workers/run-worker-process'],
    ['TypeScript SDK: Run a Worker', 'https://docs.temporal.io/develop/typescript/workers/run-worker-process'],
  ],

  quiz: [
    { q: 'How many Task Queues can a single Worker Entity poll?', o: ['As many as you list', 'Exactly one', 'Two: one for workflows, one for activities', 'All queues in the namespace'], a: 1, why: 'A Worker Entity polls a single queue. A process that needs several queues runs several Worker Entities.' },
    { q: 'You call an activity on a task queue whose workers don’t register it. What happened in our test?', o: ['The workflow failed immediately', 'The attempts failed with “not registered” and were retried until the Schedule-To-Close deadline', 'The activity ran on another queue', 'The service executed it'], a: 1, why: 'The workflow isn’t failed by the missing registration; the activity keeps retrying until its timeouts end it.' },
    { q: 'Your activity must read the file the previous activity wrote to local disk. What is the standard approach?', o: ['Use a bigger timeout', 'Have the workflow run the steps on a host-specific task queue', 'Store the file in the workflow history', 'Run everything in one activity on any worker'], a: 1, why: 'A per-host queue (obtained from a lookup activity) pins the steps to one machine. Plan for what happens if that host dies.' },
    { q: 'A worker is SIGKILLed mid-activity. The activity heartbeats and has a 2 s heartbeat timeout. Roughly how long until another worker starts attempt 2 in our tests?', o: ['Instantly', 'About 3 seconds', 'Never; it must be restarted manually', 'After the full Start-To-Close timeout (60 s)'], a: 1, why: 'About 2.9–3.3 s: the heartbeat timeout plus the 1 s retry delay.' },
    { q: 'The average Schedule-To-Start latency is ~1 s and free activity slots read 0. What does that say?', o: ['The workflow cache is too small', 'The worker is out of activity slots (or needs more worker processes)', 'The activity code has a bug', 'The Temporal Service is down'], a: 1, why: 'Tasks are waiting for a slot. Add slots or processes, mindful of downstream limits.' },
  ],
};
