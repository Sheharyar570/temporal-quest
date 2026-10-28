'use strict';

/* ---------- shared helpers ---------- */
function shell(title, sub, ...body) {
  return h('section', { class: 'widget' },
    h('div', { class: 'w-head' }, h('div', { class: 'w-title' }, '🎮 ' + title), sub ? h('div', { class: 'w-sub' }, sub) : null),
    h('div', { class: 'w-body' }, ...body));
}
const btn = (label, onclick, cls = '', disabled = false) => h('button', { class: 'btn ' + cls, onclick, disabled }, label);
const logLine = (cls, text) => h('div', { class: cls }, text);

/** Widgets keep a plain state object; render() builds the DOM and root.rerender() redraws it. */
function mount(render) {
  const root = h('div');
  root.rerender = () => root.replaceChildren(render());
  root.rerender();
  return root;
}

/* =====================================================================
   1. Durable execution: crash the worker and watch the workflow resume
   ===================================================================== */
WIDGETS.crash = () => {
  const STEPS = ['chargeCard', 'reserveStock', 'shipOrder', 'sendEmail'];
  let st;
  const fresh = () => (st = { started: false, done: 0, finished: false, workerUp: true, hist: [], logs: [], runs: {}, eid: 0, recovered: false });
  fresh();
  const ev = (t, d = '') => st.hist.push({ id: ++st.eid, t, d, fresh: true });
  const go = () => body.rerender();

  const body = mount(() => {
    const stepEls = STEPS.map((s, i) => h('div', { class: 'step' + (i < st.done ? ' done' : i === st.done && st.started && !st.finished ? ' next' : '') },
      s, h('small', {}, st.runs[s] ? 'really executed ×' + st.runs[s] : 'not run yet')));
    const memory = !st.started ? '(workflow not started)'
      : st.workerUp ? '{ nextStep: ' + (STEPS[st.done] || 'none') + ', completed: [' + STEPS.slice(0, st.done).join(', ') + '] }'
        : '💀 worker process died — in-memory state is gone';

    const controls = [
      btn('▶ Start workflow', () => { st.started = true; ev('WorkflowExecutionStarted', 'orderWorkflow'); st.logs.push(['info', 'Client started the workflow. Temporal stored the first event.']); go(); }, '', st.started),
      btn('⚙ Run next activity', () => {
        const s = STEPS[st.done];
        ev('ActivityTaskScheduled', s); ev('ActivityTaskStarted', s); ev('ActivityTaskCompleted', s + ' ✓');
        st.runs[s] = (st.runs[s] || 0) + 1; st.done++;
        st.logs.push(['good', 'Worker executed activity ' + s + ' and reported the result.']);
        if (st.done === STEPS.length) {
          st.finished = true; ev('WorkflowExecutionCompleted');
          st.logs.push(['good', '🏁 Workflow completed.']);
          if (st.recovered) Game.badge('survivor');
        }
        go();
      }, '', !st.started || !st.workerUp || st.finished),
      btn('💥 Kill the worker', () => { st.workerUp = false; st.logs.push(['bad', 'Worker crashed! Its memory is wiped. Temporal still has the full event history.']); go(); }, 'danger', !st.started || !st.workerUp || st.finished),
      btn('🔄 Start a new worker', () => {
        st.workerUp = true; st.recovered = true;
        st.logs.push(['info', 'New worker picks up the workflow and REPLAYS its history:']);
        for (let i = 0; i < st.done; i++) st.logs.push(['warn', '  replay: ' + STEPS[i] + ' → result found in history, NOT executed again']);
        st.logs.push(['good', 'State rebuilt. Continuing from ' + (STEPS[st.done] || 'the end') + '.']);
        go();
      }, 'good', st.workerUp || st.finished),
      btn('↺ Reset', () => { fresh(); go(); }, 'ghost'),
    ];

    const histBox = h('div', { class: 'hist' }, st.hist.length
      ? st.hist.map((e) => h('div', { class: e.fresh ? 'new' : '' }, h('span', { class: 'id' }, e.id), h('span', {}, e.t + (e.d ? '  ' + e.d : ''))))
      : h('div', {}, '— empty —'));
    st.hist.forEach((e) => (e.fresh = false));
    const logBox = h('div', { class: 'log' }, st.logs.map(([c, t]) => logLine(c, t)));
    setTimeout(() => { logBox.scrollTop = logBox.scrollHeight; }, 0);

    return h('div', {},
      h('div', { class: 'steps' }, stepEls),
      h('div', { class: 'row' }, controls),
      h('div', { class: 'grid2', style: 'margin-top:10px' },
        h('div', {},
          h('div', { class: 'box' }, h('h4', {}, 'Worker memory'), h('div', { class: 'mono' }, memory)),
          h('div', { class: 'box', style: 'margin-top:10px' }, h('h4', {}, 'What happened'), logBox)),
        h('div', { class: 'box' }, h('h4', {}, 'Event History (stored by Temporal Service)'), histBox)),
      st.finished ? h('div', { class: 'banner ok' }, 'The card was charged exactly once' + (st.recovered ? ', even though a worker died mid-way.' : '. Next time, try killing the worker mid-way!')) : null);
  });
  return shell('Crash the worker', 'Run the order workflow step by step. Then kill the worker mid-way and start a new one.', body);
};

/* =====================================================================
   2. Workflow code vs Activity code sorter
   ===================================================================== */
WIDGETS.sorter = () => {
  const ITEMS = [
    ['Call a payment provider’s HTTP API', 'A', 'Network calls can fail and are non-deterministic → Activity.'],
    ['await sleep("30 days")', 'W', 'Durable timers are a Workflow superpower: no thread is held, no cron needed.'],
    ['if (order.total > 100) { needsApproval = true }', 'W', 'Pure branching on workflow state is deterministic → fine in a Workflow.'],
    ['Write a row to PostgreSQL', 'A', 'Any I/O with the outside world belongs in an Activity.'],
    ['Loop over line items and call an activity for each', 'W', 'Orchestration (loops, branches, ordering) is exactly what Workflows are for.'],
    ['Send an email with SendGrid', 'A', 'Side effect on an external system → Activity (retried automatically).'],
    ['Race a 24h timer against an incoming signal', 'W', 'Timers + signals are workflow primitives, replayed deterministically.'],
    ['Read a file from local disk', 'A', 'The file may differ on replay or on another machine → Activity.'],
    ['Resize a 40MB image with a native library', 'A', 'Heavy / non-deterministic work → Activity (can heartbeat, retry, time out).'],
    ['Keep a counter that signals increment', 'W', 'Workflow state mutated by handlers is deterministic and replayed from history.'],
  ];
  let i = 0, mistakes = 0, answered = false, note = null;
  const root = mount(() => {
    if (i >= ITEMS.length) {
      if (!mistakes) Game.badge('sorter');
      return h('div', {}, h('div', { class: 'banner ' + (mistakes ? 'info' : 'ok') }, mistakes ? 'Done with ' + mistakes + ' mistake(s). Replay to aim for a perfect run!' : 'Perfect sort! 🧹'),
        btn('↺ Play again', () => { i = 0; mistakes = 0; answered = false; note = null; root.rerender(); }));
    }
    const [text, ans, why] = ITEMS[i];
    const pick = (c) => {
      if (answered) return;
      answered = true;
      if (c === ans) note = ['ok', '✔ ' + why]; else { mistakes++; note = ['bad', '✘ ' + why]; }
      root.rerender();
    };
    return h('div', {},
      h('div', { class: 'scoreline' }, h('span', {}, 'Card ', h('b', {}, (i + 1) + '/' + ITEMS.length)), h('span', {}, 'Mistakes ', h('b', {}, mistakes))),
      h('div', { class: 'scenario' }, h('code', {}, text)),
      h('div', { class: 'row' }, btn('🧠 Workflow code', () => pick('W'), '', answered), btn('⚙ Activity code', () => pick('A'), 'ghost', answered)),
      note ? h('div', { class: 'banner ' + note[0] }, note[1]) : null,
      answered ? btn('Next →', () => { i++; answered = false; note = null; root.rerender(); }) : null);
  });
  return shell('Where does this code belong?', 'Rule of thumb: Workflows decide, Activities do.', root);
};

/* =====================================================================
   3. Activity retry simulator
   ===================================================================== */
WIDGETS.retry = () => {
  const p = { fails: 3, max: 5, initial: 1, coeff: 2, nonRetry: false };
  let timers = [];
  const out = h('div', { style: 'margin-top:10px' });
  const code = codeBlock({ ts: '', py: '' }, 'Retry policy generated from your settings');

  const snippet = () => ({
    ts: "const { chargeCard } = proxyActivities<typeof activities>({\n  startToCloseTimeout: '10 seconds',\n  retry: {\n    initialInterval: '" + p.initial + "s',\n    backoffCoefficient: " + p.coeff + ",\n    maximumAttempts: " + p.max + ",\n  },\n});",
    py: "await workflow.execute_activity(\n    charge_card, order_id,\n    start_to_close_timeout=timedelta(seconds=10),\n    retry_policy=RetryPolicy(\n        initial_interval=timedelta(seconds=" + p.initial + "),\n        backoff_coefficient=" + p.coeff + ".0,\n        maximum_attempts=" + p.max + ",\n    ),\n)",
  });
  const refreshCode = () => code.update(snippet());

  const sim = () => {
    const rows = []; let t = 0;
    for (let a = 1; a <= p.max; a++) {
      const failed = a <= p.fails;
      const wait = p.initial * Math.pow(p.coeff, a - 1);
      rows.push({ a, t, failed, wait });
      if (!failed) return { rows, ok: true };
      if (p.nonRetry) return { rows, ok: false, why: 'The error was marked non-retryable, so Temporal stopped after the first attempt.' };
      if (a === p.max) return { rows, ok: false, why: 'maximumAttempts reached → the activity fails and the error surfaces in your workflow code.' };
      t += wait;
    }
  };

  const run = () => {
    timers.forEach(clearTimeout); timers = [];
    out.replaceChildren();
    const r = sim();
    r.rows.forEach((row, idx) => timers.push(setTimeout(() => {
      out.append(h('div', { class: 'attempt' }, 'Attempt ' + row.a + '  @ t=' + row.t + 's  ' + (row.failed ? '❌ failed' + (row.a < p.max && !p.nonRetry ? '  → waiting ' + row.wait + 's before retry' : '') : '✅ succeeded')));
    }, idx * 450)));
    timers.push(setTimeout(() => {
      out.append(r.ok ? h('div', { class: 'banner ok' }, 'Activity succeeded after ' + r.rows.length + ' attempt(s). The workflow never noticed the failures.')
        : h('div', { class: 'banner bad' }, r.why));
      if (r.ok && p.fails >= 3) Game.badge('retry');
    }, r.rows.length * 450));
  };

  const slider = (label, key, min, max, step = 1, unit = '') => {
    const o = h('output', {}, p[key] + unit);
    return h('label', { class: 'field' }, label, o, h('input', { type: 'range', min, max, step, value: p[key], oninput: (e) => { p[key] = +e.target.value; o.textContent = p[key] + unit; refreshCode(); } }));
  };
  refreshCode();
  return shell('Retry lab', 'The remote service fails N times, then recovers. Tune the retry policy and press Run.',
    h('div', { class: 'row', style: 'align-items:flex-end' },
      slider('Service fails first… (times)', 'fails', 0, 8),
      slider('maximumAttempts', 'max', 1, 8),
      slider('initialInterval', 'initial', 1, 5, 1, 's'),
      slider('backoffCoefficient', 'coeff', 1, 3, 1),
      h('label', { class: 'field' }, 'Error type', h('select', { onchange: (e) => (p.nonRetry = e.target.value === 'nr') }, h('option', { value: 'r' }, 'Transient (retryable)'), h('option', { value: 'nr' }, 'Non-retryable (e.g. CardDeclined)'))),
      btn('▶ Run', run)),
    out, code);
};

/* =====================================================================
   4. Workers & task queues
   ===================================================================== */
WIDGETS.workers = () => {
  const st = { queue: [], workers: [], nextTask: 1, nextWorker: 1, done: 0, fleet: false };
  const root = mount(() => {
    const queueBox = h('div', {}, st.queue.length ? st.queue.map((t) => h('span', { class: 'chip' }, 'wf-' + t.id)) : h('span', { class: 'fb' }, 'empty'));
    const wk = st.workers.map((w) => h('div', { class: 'wk' + (w.task ? ' busy' : '') + (w.queue !== 'orders' ? ' wrong' : '') },
      h('b', {}, 'Worker ' + w.id), '  polling ', h('code', {}, w.queue), h('br'),
      w.task ? '⚙ running wf-' + w.task.id : (w.queue !== 'orders' ? '😴 polling a queue nobody sends work to' : '💤 idle, long-polling'),
      ' ', btn('kill', () => kill(w), 'ghost')));
    return h('div', {},
      h('div', { class: 'row' },
        btn('＋ Start workflow', () => add(1)), btn('＋ Start 5', () => add(5)),
        btn('🧑‍🏭 Add worker (queue: orders)', () => addWorker('orders'), 'good'),
        btn('🧑‍🏭 Add worker (queue: payments)', () => addWorker('payments'), 'ghost'),
        btn('↺ Reset', () => { Object.assign(st, { queue: [], workers: [], nextTask: 1, nextWorker: 1, done: 0 }); root.rerender(); }, 'ghost')),
      h('div', { class: 'grid3', style: 'margin-top:10px' },
        h('div', { class: 'box' }, h('h4', {}, 'Task queue “orders” (' + st.queue.length + ' waiting)'), queueBox),
        h('div', { class: 'box' }, h('h4', {}, 'Workers (' + st.workers.length + ')'), wk.length ? wk : h('span', { class: 'fb' }, 'No workers! Work piles up safely in the queue.')),
        h('div', { class: 'box' }, h('h4', {}, 'Completed'), h('div', { style: 'font-size:2rem;font-weight:800' }, st.done))),
      st.workers.length === 0 && st.queue.length > 3 ? h('div', { class: 'banner info' }, 'Nothing is lost while workers are away — tasks just wait until someone polls.') : null,
      st.workers.length && st.workers.every((w) => w.queue !== 'orders') && st.queue.length ? h('div', { class: 'banner bad' }, 'Classic bug: the worker listens on a different task queue name than the client uses. Nothing runs!') : null);
  });
  function add(n) { for (let i = 0; i < n; i++) st.queue.push({ id: st.nextTask++ }); root.rerender(); }
  function addWorker(q) { st.workers.push({ id: st.nextWorker++, queue: q, task: null, left: 0 }); root.rerender(); }
  function kill(w) {
    if (w.task) st.queue.unshift(w.task); // the task times out and is rescheduled for another worker
    st.workers = st.workers.filter((x) => x !== w);
    root.rerender();
  }
  const timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); return; }
    let changed = false;
    for (const w of st.workers) {
      if (w.task && --w.left <= 0) { w.task = null; st.done++; changed = true; }
      if (!w.task && w.queue === 'orders' && st.queue.length) { w.task = st.queue.shift(); w.left = 2 + Math.floor(Math.random() * 3); changed = true; }
    }
    if (st.workers.filter((w) => w.task).length >= 3 && !st.fleet) { st.fleet = true; Game.badge('fleet'); }
    if (changed) root.rerender();
  }, 700);
  return shell('Task queue playground', 'Workers pull work from a task queue. Add several, kill one mid-task, or point one at the wrong queue.', root);
};

/* =====================================================================
   5. Signals / Queries / Updates lab (one shared mini "cart workflow")
   ===================================================================== */
function msgLab(mode) {
  const st = { items: [], done: false, workerUp: true, hist: [], eid: 1, pending: [], log: [], rejected: false, accepted: false, input: '' };
  st.hist.push({ id: 1, t: 'WorkflowExecutionStarted', d: 'cartWorkflow', fresh: false });
  const ev = (t, d = '') => st.hist.push({ id: ++st.eid, t, d, fresh: true });
  const say = (c, t) => st.log.push([c, t]);
  const go = () => root.rerender();

  function drain() {
    if (!st.workerUp) return;
    while (st.pending.length) {
      const m = st.pending.shift();
      if (m.kind === 'signal') {
        if (m.name === 'checkout') { st.done = true; ev('WorkflowExecutionCompleted'); say('good', 'workflow handled checkout → completed'); }
        else { st.items.push(m.arg); say('good', 'worker ran signal handler: items = [' + st.items.join(', ') + ']'); if (mode === 'signal') Game.badge('signal'); }
      } else { // update
        const bad = !m.arg ? 'item must not be empty' : st.items.includes(m.arg) ? 'duplicate item' : st.items.length >= 3 ? 'cart is full (max 3)' : null;
        if (bad) { say('bad', '← update REJECTED by validator: ' + bad + '  (nothing written to history)'); st.rejected = true; }
        else {
          ev('WorkflowExecutionUpdateAccepted', 'addItem("' + m.arg + '")'); st.items.push(m.arg);
          ev('WorkflowExecutionUpdateCompleted', 'result=' + st.items.length);
          say('good', '← update returned ' + st.items.length + ' (caller got a real answer)'); st.accepted = true;
        }
        if (st.rejected && st.accepted) Game.badge('update');
      }
    }
  }
  const sendItem = () => {
    const v = st.input.trim();
    if (st.done) { say('bad', '→ ✘ failed: workflow execution already completed'); return go(); }
    if (mode === 'update') {
      say('info', '→ update addItem("' + v + '") sent' + (st.workerUp ? '' : ' … ⏳ waiting for a worker to run the validator'));
      st.pending.push({ kind: 'update', arg: v });
    } else {
      if (!v) { say('bad', '→ type an item name first'); return go(); }
      ev('WorkflowExecutionSignaled', 'addItem("' + v + '")');
      say('info', '→ signal addItem("' + v + '") accepted' + (mode === 'signal' ? ' — returns nothing' : '') + (st.workerUp ? '' : ' (recorded in history, handler waits for a worker)'));
      st.pending.push({ kind: 'signal', name: 'addItem', arg: v });
    }
    st.input = ''; drain(); go();
  };
  const checkout = () => {
    if (st.done) { say('bad', '→ ✘ already completed'); return go(); }
    ev('WorkflowExecutionSignaled', 'checkout'); say('info', '→ signal checkout sent');
    st.pending.push({ kind: 'signal', name: 'checkout' }); drain(); go();
  };
  const query = () => {
    if (!st.workerUp) { say('bad', '→ query getItems ✘ failed: FAILED_PRECONDITION, no poller seen for the task queue (worker may be down)'); return go(); }
    say('good', '→ query getItems ← [' + st.items.join(', ') + ']   (history unchanged: ' + st.eid + ' events)');
    if (st.items.length) Game.badge('query');
    go();
  };

  const labels = { signal: ['Send signal addItem', '✉️'], query: ['Add item (via signal)', '➕'], update: ['Send update addItem', '🔁'] };
  const missions = {
    signal: 'Mission: send two items. Then kill the worker, send another, and watch it land in history but not in state until the worker returns.',
    query: 'Mission: add an item, query it, and notice the history length never changes. Then try querying with the worker down, and on a completed workflow.',
    update: 'Mission: add items until the validator rejects one (empty, duplicate, or a 4th item). Rejected updates leave no trace in history.',
  };
  const root = mount(() => {
    const input = h('input', { type: 'text', placeholder: 'item name', value: st.input, oninput: (e) => (st.input = e.target.value), onkeydown: (e) => e.key === 'Enter' && sendItem() });
    const hist = h('div', { class: 'hist' }, st.hist.map((e) => h('div', { class: e.fresh ? 'new' : '' }, h('span', { class: 'id' }, e.id), h('span', {}, e.t + (e.d ? '  ' + e.d : '')))));
    st.hist.forEach((e) => (e.fresh = false));
    const logBox = h('div', { class: 'log' }, st.log.map(([c, t]) => logLine(c, t)));
    setTimeout(() => { logBox.scrollTop = logBox.scrollHeight; }, 0);
    return h('div', {},
      h('div', { class: 'fb', style: 'margin-bottom:8px' }, missions[mode]),
      h('div', { class: 'grid3' },
        h('div', {},
          h('div', { class: 'box' }, h('h4', {}, 'Client'), h('label', { class: 'field' }, 'Item', input),
            h('div', { class: 'row', style: 'margin-top:6px' },
              btn(labels[mode][1] + ' ' + labels[mode][0], sendItem),
              mode === 'query' ? btn('🔍 Query getItems', query, 'good') : null,
              btn('🏁 ' + (mode === 'signal' ? 'Signal checkout' : 'Complete workflow'), checkout, 'ghost'))),
          h('div', { class: 'box', style: 'margin-top:10px' }, h('h4', {}, 'Client log'), logBox)),
        h('div', { class: 'box' }, h('h4', {}, 'Workflow state'),
          h('div', { class: 'mono' }, st.workerUp ? 'items: [' + st.items.join(', ') + ']' : '(worker down — state not in memory)'),
          h('div', { class: 'mono', style: 'margin-top:6px' }, 'status: ' + (st.done ? 'Completed' : 'Running')),
          h('div', { class: 'mono', style: 'margin-top:6px' }, 'pending: ' + st.pending.length),
          h('div', { class: 'row', style: 'margin-top:10px' },
            btn(st.workerUp ? '💥 Kill worker' : '🔄 Start worker', () => { st.workerUp = !st.workerUp; say(st.workerUp ? 'info' : 'bad', st.workerUp ? 'worker is back — replaying history, then handling pending messages' : 'worker killed'); drain(); go(); }, st.workerUp ? 'danger' : 'good'))),
        h('div', { class: 'box' }, h('h4', {}, 'Event History (' + st.eid + ' events)'), hist)));
  });
  return root;
}
WIDGETS.signalLab = () => shell('Signal lab', 'Signals are asynchronous, durable messages into a running workflow.', msgLab('signal'));
WIDGETS.queryLab = () => shell('Query lab', 'Queries are synchronous, read-only and never touch history.', msgLab('query'));
WIDGETS.updateLab = () => shell('Update lab', 'Updates are validated, tracked, and return a result to the caller.', msgLab('update'));

/* =====================================================================
   6. Schedule overlap simulator
   ===================================================================== */
WIDGETS.schedule = () => {
  const POLICIES = ['SKIP', 'BUFFER_ONE', 'BUFFER_ALL', 'CANCEL_OTHER', 'TERMINATE_OTHER', 'ALLOW_ALL'];
  const tried = new Set();
  const p = { policy: 'SKIP', dur: 25, pause: false };
  const H = 80, EVERY = 10;

  function simulate() {
    const runs = [], acts = []; let buf = 0;
    const active = () => runs.filter((r) => r.status === 'running');
    const start = (t) => { const r = { n: runs.length + 1, start: t, end: t + p.dur, status: 'running' }; runs.push(r); };
    for (let t = 0; t < H; t++) {
      runs.forEach((r) => { if (r.status === 'running' && r.end <= t) r.status = 'completed'; });
      if (buf > 0 && !active().length) { buf--; start(t); }
      if (t % EVERY) continue;
      if (p.pause && t >= 30 && t < 50) { acts.push({ t, o: 'paused', msg: 'schedule is paused → no action fires' }); continue; }
      const a = active();
      if (!a.length) { start(t); acts.push({ t, o: 'started', msg: 'started a new run' }); continue; }
      switch (p.policy) {
        case 'SKIP': acts.push({ t, o: 'skipped', msg: 'previous run still going → skipped' }); break;
        case 'BUFFER_ONE':
          if (buf < 1) { buf++; acts.push({ t, o: 'buffered', msg: 'buffered (1 slot) → starts when the current run ends' }); }
          else acts.push({ t, o: 'skipped', msg: 'buffer slot already taken → dropped' });
          break;
        case 'BUFFER_ALL': buf++; acts.push({ t, o: 'buffered', msg: 'queued (' + buf + ' waiting) → will start later' }); break;
        case 'CANCEL_OTHER': a.forEach((r) => { r.status = 'cancelled'; r.end = t; }); start(t); acts.push({ t, o: 'cancelled', msg: 'cancelled the running workflow (graceful), started a new one' }); break;
        case 'TERMINATE_OTHER': a.forEach((r) => { r.status = 'terminated'; r.end = t; }); start(t); acts.push({ t, o: 'terminated', msg: 'terminated the running workflow (forceful), started a new one' }); break;
        case 'ALLOW_ALL': start(t); acts.push({ t, o: 'started', msg: 'started alongside the running one' }); break;
      }
    }
    return { runs, acts };
  }

  const code = codeBlock({ ts: '', py: '' }, 'Schedule definition');
  const snippet = () => ({
    ts: "await client.schedule.create({\n  scheduleId: 'report-schedule',\n  spec: { intervals: [{ every: '10s' }] }, // or cronExpressions: ['0 9 * * MON-FRI']\n  policies: { overlap: ScheduleOverlapPolicy." + p.policy + " },\n  action: {\n    type: 'startWorkflow',\n    workflowType: 'reportWorkflow',\n    taskQueue: 'reports',\n  },\n});",
    py: "await client.create_schedule(\n    'report-schedule',\n    Schedule(\n        action=ScheduleActionStartWorkflow(\n            ReportWorkflow.run, id='report', task_queue='reports'),\n        spec=ScheduleSpec(\n            intervals=[ScheduleIntervalSpec(every=timedelta(seconds=10))]),\n        policy=SchedulePolicy(overlap=ScheduleOverlapPolicy." + p.policy + "),\n    ),\n)",
  });

  const view = h('div', { class: 'gantt' });
  const draw = () => {
    code.update(snippet());
    tried.add(p.policy);
    if (tried.size === POLICIES.length) Game.badge('time');
    const { runs, acts } = simulate();
    const pct = (t) => (Math.min(t, H) / H * 100) + '%';
    const trig = h('div', { class: 'gt' }, h('div', { class: 'lab' }, 'fires'),
      h('div', { class: 'track' }, p.pause ? h('div', { class: 'pausebar', style: 'left:' + pct(30) + ';width:' + (20 / H * 100) + '%' }) : null,
        acts.map((a) => h('div', { class: 'dot ' + a.o, style: 'left:' + pct(a.t), title: 't=' + a.t + 's ' + a.o }))));
    const lanes = runs.map((r) => h('div', { class: 'gt' }, h('div', { class: 'lab' }, 'run #' + r.n),
      h('div', { class: 'track' }, h('div', { class: 'bar ' + r.status + (r.end > H ? ' cut' : ''), style: 'left:' + pct(r.start) + ';width:' + ((Math.min(r.end, H) - r.start) / H * 100) + '%' }))));
    const axis = h('div', { class: 'axis' }, [0, 10, 20, 30, 40, 50, 60, 70, 80].map((t) => h('span', {}, t + 's')));
    const list = h('div', { class: 'log', style: 'margin-top:8px;max-height:150px' }, acts.map((a) => logLine(a.o === 'started' ? 'good' : a.o === 'skipped' ? '' : a.o === 'paused' ? 'info' : 'warn', 't=' + a.t + 's  ' + a.o.toUpperCase() + ' — ' + a.msg)));
    view.replaceChildren(trig, ...lanes, axis, list);
  };

  const sel = h('select', { onchange: (e) => { p.policy = e.target.value; draw(); } }, POLICIES.map((x) => h('option', { value: x }, x)));
  const dOut = h('output', {}, p.dur + 's');
  return shell('Overlap policy simulator', 'A schedule fires every 10s, but each run takes a while. What should happen when a new tick arrives while the previous run is still going?',
    h('div', { class: 'row', style: 'align-items:flex-end' },
      h('label', { class: 'field' }, 'Overlap policy', sel),
      h('label', { class: 'field' }, 'Workflow run duration', dOut, h('input', { type: 'range', min: 5, max: 40, step: 5, value: p.dur, oninput: (e) => { p.dur = +e.target.value; dOut.textContent = p.dur + 's'; draw(); } })),
      h('label', { class: 'field', style: 'flex-direction:row;align-items:center;gap:6px' }, h('input', { type: 'checkbox', onchange: (e) => { p.pause = e.target.checked; draw(); } }), 'Pause 30s–50s')),
    view, code, (draw(), h('span')));
};

/* =====================================================================
   7. Saga (compensation) simulator
   ===================================================================== */
WIDGETS.saga = () => {
  const STEPS = ['bookFlight', 'bookHotel', 'bookCar'];
  const COMP = { bookFlight: 'cancelFlight', bookHotel: 'cancelHotel', bookCar: 'cancelCar' };
  let failAt = 'bookCar', running = false;
  const log = h('div', { class: 'log', style: 'max-height:220px' });
  const lane = h('div', { class: 'steps' });
  const paint = (marks) => lane.replaceChildren(...STEPS.map((s) => h('div', { class: 'step' + (marks[s] === '✔' ? ' done' : '') }, s, h('small', {}, marks[s] || 'pending'))));
  paint({});

  const run = () => {
    if (running) return;
    running = true; log.replaceChildren(); const marks = {}; paint(marks);
    const script = []; const done = [];
    for (const s of STEPS) {
      if (s === failAt) { script.push(['bad', '✘ ' + s + ' failed (retries exhausted) → run compensations in REVERSE'], ...done.slice().reverse().map((d) => ['warn', '↩ ' + COMP[d] + '()'])); break; }
      script.push(['good', '✔ ' + s]); done.push(s);
    }
    if (failAt === 'none') script.push(['good', '🏁 Trip fully booked — no compensation needed']);
    else if (done.length === 0) script.push(['info', 'Nothing to undo: the very first step failed.']);
    else script.push(['info', 'All side effects undone. The workflow ends in a consistent state.']);
    let k = 0, doneSoFar = [];
    const tick = () => {
      if (k >= script.length) { running = false; if (failAt === 'bookCar') Game.badge('saga'); return; }
      const [c, t] = script[k++];
      log.append(logLine(c, t)); log.scrollTop = log.scrollHeight;
      if (t.startsWith('✔')) { marks[t.slice(2)] = '✔'; doneSoFar.push(t.slice(2)); }
      else if (t.startsWith('✘')) marks[failAt] = '✘ failed';
      else if (t.startsWith('↩')) { const name = Object.keys(COMP).find((s) => t.includes(COMP[s])); marks[name] = '↩ undone'; }
      paint(marks); setTimeout(tick, 650);
    };
    tick();
  };
  const sel = h('select', { onchange: (e) => (failAt = e.target.value) }, ['bookCar', 'bookHotel', 'bookFlight', 'none'].map((x) => h('option', { value: x }, x === 'none' ? 'nothing fails' : x + ' fails')));
  return shell('Saga simulator: book a trip', 'Choose which step fails, then watch the compensation run in reverse order.',
    h('div', { class: 'row', style: 'align-items:flex-end' }, h('label', { class: 'field' }, 'Failure injection', sel), btn('▶ Run saga', run)),
    lane, h('div', { class: 'box' }, h('h4', {}, 'Workflow log'), log));
};

/* =====================================================================
   8. Human approval: signal vs timer race
   ===================================================================== */
WIDGETS.approval = () => {
  const LIMIT = 10;
  let left = LIMIT, decision = null, timer = null;
  const root = mount(() => {
    const outcome = decision === 'timeout' ? ['bad', '⏰ Timer won the race → workflow escalates to the director automatically.']
      : decision === 'approved' ? ['ok', '✅ Signal won the race → timer cancelled, expense approved.']
        : decision === 'rejected' ? ['bad', '🚫 Signal won the race → expense rejected.'] : null;
    return h('div', {},
      h('div', { class: 'scenario' }, '💶 Expense of €4,200 awaits manager approval. ',
        h('b', {}, decision ? 'Resolved' : 'Timer: ' + left + 's left (stands in for 24 hours)')),
      h('div', { class: 'row' },
        btn('👍 Signal: approve(true)', () => resolve('approved'), 'good', !!decision),
        btn('👎 Signal: approve(false)', () => resolve('rejected'), 'danger', !!decision),
        btn('↺ New request', start, 'ghost')),
      outcome ? h('div', { class: 'banner ' + outcome[0] }, outcome[1]) : null,
      h('div', { class: 'fb', style: 'margin-top:8px' }, 'Do nothing and the timer wins. Click quickly and the signal wins. Either way the workflow was just waiting — no polling, no thread held.'));
  });
  function resolve(d) { clearInterval(timer); decision = d; Game.badge('human'); root.rerender(); }
  function start() {
    clearInterval(timer); left = LIMIT; decision = null;
    timer = setInterval(() => {
      if (!root.isConnected) return clearInterval(timer);
      if (--left <= 0) { clearInterval(timer); decision = 'timeout'; Game.badge('human'); }
      root.rerender();
    }, 1000);
    root.rerender();
  }
  start();
  return shell('Approval race', 'The classic human-in-the-loop pattern: wait for a signal OR a timeout, whichever comes first.', root);
};

/* =====================================================================
   9. Final challenge: pick the primitive
   ===================================================================== */
WIDGETS.boss = () => {
  const PRIMS = ['Workflow', 'Activity', 'Worker', 'Signal', 'Query', 'Update', 'Schedule'];
  const ALL = [
    ['Charge a credit card through the Stripe API.', 'Activity', 'Side effects on external systems live in Activities.'],
    ['Run a cleanup job every weekday at 09:00.', 'Schedule', 'Recurring execution is what Schedules are for (replacing cron).'],
    ['A dashboard must show the current cart contents without changing anything.', 'Query', 'Queries are synchronous and read-only.'],
    ['Tell a running order that the customer cancelled; no reply needed.', 'Signal', 'Fire-and-forget, durable message into a running workflow.'],
    ['Change the shipping address of a running order and learn immediately whether it was accepted.', 'Update', 'Updates are validated and return a result to the caller.'],
    ['The durable, deterministic function that orchestrates the steps of an order.', 'Workflow', 'Workflows hold the orchestration logic and survive crashes.'],
    ['The process you deploy that polls a task queue and runs your workflow and activity code.', 'Worker', 'Workers execute your code; the Temporal Service never does.'],
    ['Wait 30 days, then send a reminder, without any cron job or database poller.', 'Workflow', 'A durable timer (sleep) inside a Workflow does exactly this.'],
  ];
  let order, i, score, streak, answered, note;
  const reset = () => { order = ALL.slice().sort(() => Math.random() - 0.5); i = 0; score = 0; streak = 0; answered = false; note = null; };
  reset();
  const root = mount(() => {
    if (i >= order.length) {
      if (score >= 7) Game.badge('boss');
      return h('div', {}, h('div', { class: 'banner ' + (score >= 7 ? 'ok' : 'info') }, 'Final score: ' + score + '/' + order.length + (score >= 7 ? ' — 👑 Primitive Master!' : ' — get 7+ for the crown.')), btn('↺ Try again', () => { reset(); root.rerender(); }));
    }
    const [text, ans, why] = order[i];
    const pick = (p) => { if (answered) return; answered = true; if (p === ans) { score++; streak++; note = ['ok', '✔ ' + why]; } else { streak = 0; note = ['bad', '✘ It was ' + ans + '. ' + why]; } root.rerender(); };
    return h('div', {},
      h('div', { class: 'scoreline' }, h('span', {}, 'Question ', h('b', {}, (i + 1) + '/' + order.length)), h('span', {}, 'Score ', h('b', {}, score)), h('span', {}, 'Streak ', h('b', {}, streak + (streak > 2 ? ' 🔥' : '')))),
      h('div', { class: 'scenario' }, text),
      h('div', { class: 'bucket-row' }, PRIMS.map((p) => btn(p, () => pick(p), 'ghost', answered))),
      note ? h('div', { class: 'banner ' + note[0] }, note[1]) : null,
      answered ? btn('Next →', () => { i++; answered = false; note = null; root.rerender(); }) : null);
  });
  return shell('Boss fight: pick the right primitive', 'Eight real-world scenarios. Which Temporal building block fits?', root);
};
