'use strict';

/* ---------- tiny DOM helper ---------- */
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- gamification ---------- */
const BADGES = {
  survivor: { icon: '🛡️', name: 'Crash Survivor', desc: 'Resumed a workflow after a worker crash' },
  sorter: { icon: '🧹', name: 'Clean Separator', desc: 'Sorted workflow vs activity code with zero mistakes' },
  retry: { icon: '🔁', name: 'Retry Wizard', desc: 'Got an activity to succeed after 3+ failures' },
  fleet: { icon: '🚢', name: 'Fleet Commander', desc: 'Had 3 workers busy at the same time' },
  signal: { icon: '📨', name: 'Fire & Forget', desc: 'Sent a signal and watched it get applied' },
  query: { icon: '🔍', name: 'Read-Only Detective', desc: 'Queried a workflow without changing history' },
  update: { icon: '✅', name: 'Validator', desc: 'Saw an update accepted and one rejected' },
  time: { icon: '⏰', name: 'Time Lord', desc: 'Tried all six schedule overlap policies' },
  saga: { icon: '↩️', name: 'Saga Master', desc: 'Watched compensations roll back a failed booking' },
  human: { icon: '🙋', name: 'Human in the Loop', desc: 'Resolved an approval workflow (signal vs timer)' },
  boss: { icon: '👑', name: 'Primitive Master', desc: 'Scored 7/8+ in the final challenge' },
  graduate: { icon: '🎓', name: 'Temporal Graduate', desc: 'Completed every module' },
  deepSignals: { icon: '📡', name: 'Signal Specialist', desc: 'Finished the Signals deep dive' },
  deepUpdates: { icon: '🧾', name: 'Update Architect', desc: 'Finished the Updates deep dive' },
  deepQueries: { icon: '🔭', name: 'Query Specialist', desc: 'Finished the Queries deep dive' },
  deepActivities: { icon: '🛠️', name: 'Activity Engineer', desc: 'Finished the Activities deep dive' },
  deepSchedules: { icon: '⏰', name: 'Schedule Keeper', desc: 'Finished the Schedules deep dive' },
  deepWorkers: { icon: '🧑‍🏭', name: 'Worker Wrangler', desc: 'Finished the Workers deep dive' },
  deepWorkflows: { icon: '🧠', name: 'Workflow Architect', desc: 'Finished the Workflows deep dive' },
};
const LEVELS = ['Curious Newcomer', 'Task Runner', 'Retry Wrangler', 'Signal Sender', 'Workflow Weaver', 'Saga Architect', 'Temporal Master'];
const XP_PER_LEVEL = 140;

const Game = {
  key: 'temporal-quest-v1',
  s: { xp: 0, badges: {}, answers: {}, done: {}, lang: 'ts' },
  onChange: () => {},
  load() {
    try { Object.assign(this.s, JSON.parse(localStorage.getItem(this.key)) || {}); } catch (e) { /* private mode etc. */ }
  },
  save() {
    try { localStorage.setItem(this.key, JSON.stringify(this.s)); } catch (e) { /* ignore */ }
    this.onChange();
  },
  reset() {
    this.s = { xp: 0, badges: {}, answers: {}, done: {}, lang: this.s.lang };
    this.save();
  },
  level() { return Math.min(Math.floor(this.s.xp / XP_PER_LEVEL), LEVELS.length - 1); },
  addXp(n, why) {
    const before = this.level();
    this.s.xp += n;
    this.save();
    toast('+' + n + ' XP', why);
    if (this.level() > before) toast('🎉 Level up!', 'You are now a ' + LEVELS[this.level()]);
  },
  badge(id) {
    if (this.s.badges[id]) return;
    this.s.badges[id] = true;
    const b = BADGES[id];
    toast(b.icon + ' Badge unlocked: ' + b.name, b.desc, 'badge-toast');
    this.addXp(25, 'Badge bonus');
  },
};

function toast(title, body, cls = '') {
  const t = h('div', { class: 'toast ' + cls }, h('b', {}, title), body ? h('div', { class: 'fb' }, body) : null);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4200);
}

/* ---------- syntax highlighting (tiny, regex based) ---------- */
const TS_RE = /(\/\/.*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|from|export|async|await|function|const|let|return|if|else|for|of|while|new|type|interface|throw|try|catch|null|true|false|undefined|typeof)\b|\b(\d+)\b/g;
const PY_RE = /(#.*)|("""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(@[\w.]+)|\b(def|class|async|await|import|from|return|if|else|elif|for|in|with|as|None|True|False|self|raise|try|except|while|not|and|or|pass|lambda|yield)\b|\b(\d+)\b/g;
const TS_CLS = ['c', 's', 'k', 'n'];
const PY_CLS = ['c', 's', 'd', 'k', 'n'];

function highlight(src, lang) {
  const re = lang === 'py' ? PY_RE : TS_RE;
  const cls = lang === 'py' ? PY_CLS : TS_CLS;
  re.lastIndex = 0;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const g = cls.findIndex((_, i) => m[i + 1] !== undefined);
    out += '<span class="tok-' + cls[g] + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
}

/**
 * Code block with TS / Python variants. The header language switch picks which one is visible.
 * `snips` = { ts: '...', py: '...', file?: 'name' }. The returned element has .update(snips).
 */
function codeBlock(snips, title = '') {
  const wrap = h('div', { class: 'code' });
  const copy = h('button', { onclick: () => {
    const lang = document.body.dataset.lang;
    const text = (snips.cur[lang] || snips.cur.ts || snips.cur.py);
    navigator.clipboard?.writeText(text).then(() => { copy.textContent = 'Copied!'; setTimeout(() => (copy.textContent = 'Copy'), 1200); });
  } }, 'Copy');
  wrap.append(h('div', { class: 'bar' }, h('span', {}, title), copy));
  const pres = {};
  const fill = (s) => {
    snips.cur = s;
    for (const l of ['ts', 'py']) {
      if (!s[l]) { pres[l]?.remove(); delete pres[l]; continue; }
      if (!pres[l]) { pres[l] = h('pre', { class: l }); wrap.append(pres[l]); }
      pres[l].innerHTML = highlight(s[l], l);
      pres[l].classList.toggle('only', !(s.ts && s.py));
    }
  };
  fill(snips);
  wrap.update = (s) => fill(Object.assign({}, s));
  return wrap;
}

/* ---------- quiz ---------- */
function quiz(mod, questions, onAnswer) {
  const box = h('div', { class: 'quiz' }, h('h3', {}, '🧠 Knowledge check'));
  questions.forEach((q, qi) => {
    const id = mod.id + ':' + qi;
    const fb = h('div', { class: 'fb' });
    const btns = q.o.map((text, oi) => h('button', { class: 'opt', onclick: () => pick(oi) }, text));
    const lock = () => btns.forEach((b) => (b.disabled = true));
    function pick(oi) {
      const rec = Game.s.answers[id] || { ok: false, tries: 0 };
      if (rec.ok) return;
      if (oi === q.a) {
        btns[oi].classList.add('right');
        fb.textContent = '✔ ' + q.why;
        lock();
        Game.s.answers[id] = { ok: true, tries: rec.tries };
        Game.addXp(rec.tries === 0 ? 10 : 5, 'Correct answer');
        onAnswer && onAnswer();
      } else {
        btns[oi].classList.add('wrong');
        btns[oi].disabled = true;
        fb.textContent = 'Not quite — have another go.';
        Game.s.answers[id] = { ok: false, tries: rec.tries + 1 };
        Game.save();
      }
    }
    if (Game.s.answers[id]?.ok) { btns[q.a].classList.add('right'); fb.textContent = '✔ ' + q.why; lock(); }
    box.append(h('div', { class: 'q' }, h('p', {}, (qi + 1) + '. ' + q.q), btns, fb));
  });
  return box;
}

/* ---------- registries filled by other files ---------- */
const WIDGETS = {};
const DEEP = {};      // topic -> deep-dive content (js/deep/<topic>.js)
const DEEP_CODE = {}; // topic -> verified code (generated: js/deep/<topic>.code.js)
