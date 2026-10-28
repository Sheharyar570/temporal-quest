'use strict';

/*
 * Deep dive: Schedules.
 * Facts come from docs.temporal.io and the SDKs' own type definitions (see `sources`); behaviour the pages
 * don't state was checked by running it. Every use case's code is the file in examples/schedules/* that
 * passed its tests (Python 1.34.0, TypeScript 1.24.0, 2026-10-28).
 */
DEEP.schedules = {
  title: 'Schedules in depth',
  badge: 'deepSchedules',
  verified: 'Verified 2026-10-28 · temporalio Python 1.34.0 · @temporalio/* TypeScript 1.24.0 · 16 scenarios pass in Python, 18 in TypeScript, in real time against a local Temporal dev server (CLI 1.9.1, server 1.32.0)',

  under: `
    <h2>Under the hood</h2>
    <h3>A Schedule is its own object</h3>
    <p>A Schedule has its own ID and lives independently of any workflow execution (the older “cron workflow” stores the cron string on the workflow itself, and the docs recommend Schedules instead). It holds a <b>spec</b> (when), an <b>action</b> (what to start), <b>policies</b> (overlap, catch-up, pause-on-failure) and <b>state</b> (paused, note, remaining actions). You can pause, edit, trigger, backfill, describe and delete it while it runs. For a single future start, the docs point to <b>Start Delay</b> rather than a Schedule.</p>

    <h3>The spec: when it fires</h3>
    <ul>
      <li><b>Intervals</b> (“every 30 minutes”) are aligned to the Unix epoch, with an optional phase offset. <b>Calendars</b> are cron-like (<code>hour</code>, <code>minute</code>, <code>second</code> default to <code>0</code>; the other fields default to <code>*</code>). <b>Cron expressions</b> are also accepted, and one spec can mix all three.</li>
      <li><b>Time zone:</b> calendar specs are UTC unless you name a zone, and the docs recommend UTC. We created <code>09:00 America/New_York</code> and the next fire times (shown in UTC) were <b>13:00, 13:00, 13:00, 13:00, then 14:00 on 1 Nov</b>: the schedule follows daylight-saving time for you (this output is from the run date, 28 Oct 2026).</li>
      <li><b>Exclusions</b> (<code>skip</code> in both SDKs) subtract times, for example holidays. <b>Jitter</b> adds a random offset between zero and the maximum to each action. <b>Start/end</b> bound the whole schedule. The docs say actions should generally start within 1 second of their time.</li>
    </ul>

    <h3>What a scheduled run looks like</h3>
    <ul>
      <li><b>Workflow ID = your base ID + the action’s timestamp, to the second</b> (we saw <code>sync-&lt;schedule id&gt;-2026-10-28T07:57:31Z</code>). This makes every run unique, and it also means <b>two schedules that share a base ID can collide</b> (use case 1).</li>
      <li>Every run carries the search attributes <code>TemporalScheduledById</code> (the schedule’s ID) and <code>TemporalScheduledStartTime</code> (the slot it was for). We read both in tests, and a workflow can read its own slot time.</li>
      <li>The run can read the <b>last successful result</b> and the <b>last failure</b> (a success clears the failure). The result blob is limited to 2 MiB by default.</li>
    </ul>

    <h3>Overlap, catch-up, pause</h3>
    <table>
      <tr><th>Policy</th><th>Docs</th><th>What we measured (3 triggers at 0, 1, 2 s; a 4 s job)</th></tr>
      <tr><td><code>SKIP</code> (default)</td><td>new run is not started</td><td>1 started, 2 skipped</td></tr>
      <tr><td><code>BUFFER_ONE</code></td><td>one run waits</td><td>2 started, <b>1 counted as skipped</b></td></tr>
      <tr><td><code>BUFFER_ALL</code></td><td>runs queue and start one after another</td><td>3 started, never more than 1 at a time</td></tr>
      <tr><td><code>CANCEL_OTHER</code></td><td>cancels the running one, then starts the new one</td><td>3 started; the first two <b>Cancelled</b></td></tr>
      <tr><td><code>TERMINATE_OTHER</code></td><td>terminates the running one</td><td>3 started; two <b>Terminated</b></td></tr>
      <tr><td><code>ALLOW_ALL</code></td><td>concurrent runs allowed</td><td>3 started, <b>3 at once</b></td></tr>
    </table>
    <p>The <b>catch-up window</b> bounds how far back the service will run actions it missed (for example during an outage): the docs give a default of <b>one year</b> and a minimum of <b>ten seconds</b>, and manual triggers and backfills ignore it. We did not test it. <b>Pausing</b> makes the spec inert but leaves runs in flight alone, and a paused run still counts for overlap decisions (docs).</p>
  `,

  cases: [
    /* -------------------------------------------------------------- 1 */
    {
      key: 'report', level: 'Medium', title: 'A daily report: time zones, trigger, pause, update and the ID trap',
      scenario: 'Finance wants a report at 09:00 New York time every day, whatever the DST situation. Operations needs to run it on demand, pause it during maintenance, change its input, stop it after a trial period, and remove it, without disturbing reports that are already running.',
      why: 'These are the day-to-day operations on a schedule. Each one is a single call; the interesting part is what each call does and does not touch.',
      design: [
        'The calendar spec is <code>hour=9</code> with <code>time_zone_name="America/New_York"</code>. <code>minute</code> and <code>second</code> default to 0.',
        'The action starts <code>ReportWorkflow(region, seconds_of_work)</code> with an ID base that <b>includes the schedule’s own ID</b>.',
        'The workflow reads <code>TemporalScheduledStartTime</code> so a report knows which slot it is for.',
        'Operations use <code>trigger</code>, <code>pause</code>/<code>unpause</code>, <code>update</code>, <code>delete</code> and a limited-actions counter.',
      ],
      tested: [
        '<b>Time zone:</b> every upcoming fire time was exactly 09:00:00 in New York, with the minute defaulting to 0, and UTC jumped from 13:00 to 14:00 across the 1 Nov DST change.',
        '<b>Trigger:</b> a manual run got ID <code>report-&lt;schedule&gt;-&lt;timestamp&gt;</code>, carried <code>TemporalScheduledById</code> equal to the schedule ID and a <code>TemporalScheduledStartTime</code>, and the workflow could read that time.',
        '<b>Pause:</b> a schedule firing every second recorded <b>no new actions for 3.5 s while paused</b>; the run already in flight finished normally; a manual <code>trigger</code> still ran; after <code>unpause</code> the spec fired again.',
        '<b>Update:</b> changing the action’s arguments affected the next run (<code>apac</code> instead of <code>emea</code>).',
        '<b>Limited actions:</b> with 2 remaining, exactly 2 runs started and then nothing more over the next 3 s. The state read <code>remaining = 0</code> and <b><code>paused</code> stayed false</b>, so check <code>remaining_actions</code>, not the paused flag.',
        '<b>Delete:</b> a run started by the schedule was still Running after the schedule was deleted and then completed; <code>describe</code> on the deleted schedule failed.',
        '<b>The ID trap:</b> two schedules with the <b>same workflow ID base</b>, fired within the same second, produced <b>one run: one schedule recorded 0 actions, with no error and no “skipped” count</b>. Distinct bases (our default, built from the schedule ID) did not collide.',
      ],
      pitfalls: [
        '<b>Always make the workflow ID base unique per schedule.</b> Scheduled IDs have one-second resolution, and the colliding run is silently lost in what <code>describe</code> reports. This bit our own test suite, which showed as a run that “never started” about half the time.',
        '<b>A limited schedule is not “paused”.</b> Don’t alert on <code>state.paused</code> to detect that it has finished.',
        '<b>Prefer UTC unless a human-facing local time matters.</b> The docs recommend UTC; a named zone is right when the business says “9 am New York”, DST included.',
        '<b>Deleting a schedule won’t stop its runs.</b> Cancel them separately if you need to.',
        'The docs say a schedule that has started all its workflows can be auto-deleted by the service at a time that isn’t guaranteed, and that <code>list</code> is eventually consistent. We did not test either.',
      ],
      variations: ['Add <code>skip</code> calendars for public holidays.', 'Use an <b>interval</b> with a phase offset for “every 6 h at :15”.', 'Add <code>jitter</code> so a thousand per-customer schedules don’t all fire on the hour.'],
    },
    /* -------------------------------------------------------------- 2 */
    {
      key: 'overlap', level: 'Hard', title: 'Overlap policies compared: what really happens to the old run and the new one',
      scenario: 'A job takes 4 s but fires more often than that. For each policy you need to know how many runs start, how many run at once, and what happens to the run already in progress, before you choose one for a real schedule.',
      why: 'Overlap policy is the Schedules decision that changes data. Choosing wrong either drops work (SKIP), piles it up (BUFFER_ALL), or kills it half-way (TERMINATE_OTHER). Measuring beats guessing.',
      design: [
        'A schedule with an <b>empty spec</b> and one policy under test, fired by hand with <code>trigger</code> at t = 0 s, 1 s and 2 s while a 4 s workflow is running. Manual triggers make the timing exact.',
        'After everything settles, read <code>describe().info</code> (actions taken, skipped for overlap), then the status and start/close times of every run the schedule started.',
        '“Peak concurrency” is computed from those start and close times.',
        'The same harness runs for all six policies in both SDKs.',
      ],
      tested: [
        '<b>SKIP:</b> 1 started, 2 skipped, 1 Completed, peak 1.',
        '<b>BUFFER_ONE:</b> 2 started (the first, then one buffered run), <b>1 counted as skipped</b> (the second trigger found the buffer full), both Completed, peak 1.',
        '<b>BUFFER_ALL:</b> 3 started, all Completed, <b>never more than 1 at a time</b>.',
        '<b>CANCEL_OTHER:</b> 3 started; the first two ended <b>Cancelled</b> and the last Completed. The same for <b>TERMINATE_OTHER</b> with <b>Terminated</b>.',
        '<b>ALLOW_ALL:</b> 3 started and <b>3 ran concurrently</b>.',
        '<b>All six matched the docs and were identical in Python and TypeScript</b>, once the TypeScript call was written correctly (next section).',
      ],
      pitfalls: [
        '<b>TypeScript’s <code>trigger()</code> with no argument runs as <code>ALLOW_ALL</code>, not as the schedule’s policy.</b> Its type documentation says so. We confirmed it: a <code>SKIP</code> schedule given three bare triggers ran all three concurrently with <b>zero skipped</b>. Python’s default (unspecified) honours the schedule’s policy, as the docs say. In TypeScript write <code>trigger(policy)</code>. The docs page for TypeScript says triggers are subject to the schedule’s overlap policy by default, which is not what the SDK does.',
        '<b>CANCEL_OTHER is only as graceful as the workflow.</b> Ours doesn’t catch the cancel, so it ended Cancelled at once. A workflow that cleans up first takes longer, and the new run starts after the cancellation completes (docs).',
        '<b>TERMINATE_OTHER gives no chance to clean up.</b> Don’t use it for runs holding locks or half-written state.',
        '<b>BUFFER_ALL has no limit</b> on the backlog it will build if runs are slower than the interval.',
        'These are the outcomes for a <em>manual</em> burst. Fire times from the spec follow the same policy, but we measured only triggers.',
      ],
      variations: ['<code>SKIP</code> plus an idempotent workflow is the common safe default.', '<code>BUFFER_ONE</code> gives “run again once after this one” without a pile-up.', '<code>ALLOW_ALL</code> for runs that are independent by design (per-tenant jobs).'],
    },
    /* -------------------------------------------------------------- 3 */
    {
      key: 'sync', level: 'Hard', title: 'An incremental sync: last-completion-result, pause on failure and backfill',
      scenario: 'Every minute, copy only the rows added since the last successful run. If the source is down, stop hammering it and page someone. After an outage or a bug fix, replay the minutes that were missed, each with its own identity.',
      why: 'The schedule already remembers the last good result and which runs failed. Used well, that replaces a watermark table, an “is it broken?” flag and a hand-written replay script.',
      design: [
        'The workflow takes its <b>watermark from the last completion result</b> (Python <code>get_last_completion_result</code>, TypeScript <code>workflowInfo().lastResult</code>), syncs rows above it, and returns the new watermark.',
        'It also records whether the previous run failed (<code>get_last_failure</code> / <code>lastFailure</code>).',
        'The schedule sets <b><code>pause_on_failure</code></b>. A failure in the source is a non-retryable error so it surfaces immediately.',
        '<b>Backfill</b> re-creates the missed slots with <code>ALLOW_ALL</code>. A <b>paused</b> schedule is used so only the backfill runs.',
      ],
      tested: [
        '<b>Watermark:</b> run 1 synced rows 1–5; after 3 new rows, run 2 processed <b>only those 3</b> (each row processed exactly once).',
        '<b>Failure:</b> with the source down, run 3 failed and the watermark did not move. Run 4 resumed from 8, synced row 9 and <b>saw the previous failure</b>. Run 5 saw <b>no</b> failure: a success clears it.',
        '<b>Pause on failure:</b> a failed run paused the schedule with the note <code>paused due to workflow failure: &lt;run id&gt;: Activity task failed</code>. A <b>cancelled</b> run and a <b>terminated</b> run did <b>not</b> pause it, as the docs say.',
        '<b>Backfill:</b> a 5-minute window on a 1-minute interval produced exactly <b>5 runs</b>, each with its own workflow ID, whose <code>TemporalScheduledStartTime</code> values were the five minute boundaries from window start (inclusive) up to the last whole minute. The schedule itself stayed paused.',
        '<b>TypeScript, bare <code>trigger()</code>:</b> because it runs as <code>ALLOW_ALL</code>, <b>run 2 received no last result</b> (it re-processed rows 1–5) and a failing run <b>did not pause the schedule</b> (12 s observed). The same code with <code>trigger(SKIP)</code> behaved exactly like Python.',
      ],
      pitfalls: [
        '<b>Runs the schedule doesn’t track don’t feed it.</b> The TypeScript finding is an observation about triggers started with <code>ALLOW_ALL</code>; we did not test an <code>ALLOW_ALL</code> schedule’s timed runs. If a schedule must keep a watermark or auto-pause, use a policy that tracks the run (such as SKIP).',
        '<b>Make the sync idempotent anyway.</b> A run that fails after writing some rows is retried from the old watermark, so duplicates are possible; the example’s activity is atomic, a real one may not be.',
        '<b>Backfill and pause:</b> the backfill ran on a paused schedule in our test; the docs say backfills aren’t limited by the catch-up window. We did not test the catch-up window itself.',
        'The last result is small by design (2 MiB by default, and results close to the limit aren’t passed on). Keep a cursor, not data.',
        '<b>A failure pauses the whole schedule</b>, including for transient problems. Choose it for “stop and look”, not for flaky sources: retries inside the activity are the first line of defence.',
      ],
      variations: ['A weekly “reconcile” schedule with <code>BUFFER_ONE</code> beside the per-minute one.', 'After the fix, <code>unpause</code> and backfill the paused window.', 'Surface the pause note in your alerting.'],
    },
  ],

  checklist: `
    <h2>Production checklist for schedules</h2>
    <ul>
      <li>☐ Each schedule’s workflow ID base is unique (include the schedule ID).</li>
      <li>☐ The overlap policy is chosen on purpose (SKIP, or BUFFER_ONE, unless every tick must run).</li>
      <li>☐ The scheduled workflow is idempotent: it can run twice or late and do no harm.</li>
      <li>☐ Time zone is UTC, or a named zone with the DST behaviour agreed.</li>
      <li>☐ In TypeScript, <code>trigger()</code> and <code>backfill()</code> pass the overlap policy explicitly.</li>
      <li>☐ Failure handling is decided: pause-on-failure, or retries/alerts inside the workflow.</li>
      <li>☐ Alerts exist for paused schedules and for runs that don’t start (a collision is silent).</li>
      <li>☐ Jitter is set where many schedules share the same wall-clock time.</li>
      <li>☐ A runbook says how to backfill after an outage and how to unpause.</li>
      <li>☐ Schedules are defined in code or config and created idempotently, not by hand.</li>
    </ul>`,

  sources: [
    ['Schedules', 'https://docs.temporal.io/schedule'],
    ['Python SDK: Schedules', 'https://docs.temporal.io/develop/python/workflows/schedules'],
    ['TypeScript SDK: Schedules', 'https://docs.temporal.io/develop/typescript/workflows/schedules'],
    ['CLI: temporal schedule', 'https://docs.temporal.io/cli/schedule'],
  ],

  quiz: [
    { q: 'Two schedules use the same workflow ID base and fire in the same second. What did we observe?', o: ['Both ran', 'One run started and the other schedule recorded 0 actions, with no error', 'The service queued the second run', 'Both failed with an error'], a: 1, why: 'Scheduled IDs are base + timestamp to the second. A collision lost one run silently. Make the base unique per schedule.' },
    { q: 'You set a SKIP schedule in TypeScript and call handle.trigger() three times while a run is going. What happens?', o: ['Two are skipped', 'All three run, because a bare trigger() uses ALLOW_ALL', 'They are buffered', 'The first is cancelled'], a: 1, why: 'The TypeScript SDK’s default for trigger() is ALLOW_ALL. Pass the policy: trigger(ScheduleOverlapPolicy.SKIP).' },
    { q: 'A run is in progress and the next tick arrives. Which policy leaves the first run Cancelled and starts the new one?', o: ['SKIP', 'BUFFER_ONE', 'CANCEL_OTHER', 'ALLOW_ALL'], a: 2, why: 'CANCEL_OTHER cancels the running workflow, then starts the new one. TERMINATE_OTHER does the same without cleanup.' },
    { q: 'You paused a schedule while a report was running. What happens to that report?', o: ['It is terminated', 'It is cancelled', 'It keeps running; only the spec stops firing', 'It restarts after unpause'], a: 2, why: 'Pausing makes the spec inert but leaves runs in flight alone (verified).' },
    { q: 'With pause-on-failure enabled, which scheduled run ending pauses the schedule?', o: ['A cancelled run', 'A terminated run', 'A failed or timed-out run', 'Any run that takes more than one second'], a: 2, why: 'Failures and timeouts pause; cancellations and terminations don’t (docs, and we tested cancel and terminate).' },
  ],
};
