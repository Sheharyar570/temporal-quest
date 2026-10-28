'use strict';

const main = $('#main');
const nav = $('#nav');

/* ---------- header / nav ---------- */
function renderHeader() {
  const lvl = Game.level();
  $('#level').textContent = '⭐ Lv ' + (lvl + 1) + ' · ' + LEVELS[lvl];
  const into = Game.s.xp - lvl * XP_PER_LEVEL;
  $('#xpfill').style.width = (lvl === LEVELS.length - 1 ? 100 : Math.min(100, into / XP_PER_LEVEL * 100)) + '%';
  $('#xptext').textContent = Game.s.xp + ' XP';
}

function renderNav() {
  const cur = location.hash || '#/';
  const link = (href, label, extra) => h('a', { href, class: cur === href ? 'active' : '' }, label, extra);
  const doneCount = Object.keys(Game.s.done).length;
  nav.replaceChildren(
    link('#/', '🏠 Home'),
    h('div', { class: 'sep' }),
    ...MODULES.flatMap((m, i) => [
      link('#/m/' + m.id, m.icon + ' ' + (i + 1) + '. ' + m.title, Game.s.done[m.id] ? h('span', { class: 'tick' }, '✓') : null),
      DEEP[m.id] ? h('a', { href: '#/m/' + m.id + '/deep', class: 'sub' + (cur === '#/m/' + m.id + '/deep' ? ' active' : '') }, '📚 Go deeper', Game.s.badges[DEEP[m.id].badge] ? h('span', { class: 'tick' }, '✓') : null) : null,
    ].filter(Boolean)),
    h('div', { class: 'sep' }),
    link('#/badges', '🏅 Badges', h('span', { class: 'tick', style: 'color:var(--muted)' }, Object.keys(Game.s.badges).length + '/' + Object.keys(BADGES).length)),
    h('div', { class: 'fb', style: 'padding:6px 12px' }, doneCount + '/' + MODULES.length + ' modules complete'));
}

/* ---------- pages ---------- */
function homePage() {
  const nextMod = MODULES.find((m) => !Game.s.done[m.id]) || MODULES[0];
  const started = Object.keys(Game.s.answers).length > 0 || Object.keys(Game.s.done).length > 0;
  return h('div', {},
    h('div', { class: 'hero' },
      h('h1', {}, 'Learn Temporal by playing'),
      h('p', { class: 'lead' }, 'Ten short, hands-on modules: Workflows, Activities, Workers, Signals, Queries, Updates, Schedules and the patterns that combine them. Every concept has a simulator you can break on purpose, plus quizzes, XP and badges.'),
      h('a', { class: 'btn', href: '#/m/' + nextMod.id, style: 'text-decoration:none;display:inline-block' }, started ? '▶ Continue: ' + nextMod.title : '🚀 Start the quest')),
    h('h2', {}, 'Quest map'),
    h('div', { class: 'cards' }, MODULES.map((m, i) => h('a', { class: 'card link' + (Game.s.done[m.id] ? ' done' : ''), href: '#/m/' + m.id },
      h('div', { class: 'ico' }, m.icon), h('h3', {}, (i + 1) + '. ' + m.title), h('p', {}, m.blurb),
      h('div', { class: 'meta' }, h('span', { class: 'pill' }, '⏱ ' + m.time), Game.s.done[m.id] ? h('span', { class: 'pill' }, '✓ complete') : null)))),
    h('div', { class: 'callout tip' }, h('b', { class: 't' }, 'How it works'),
      'Read a short lesson → play with the simulator → answer the knowledge check. Finish a module’s quiz to complete it (+40 XP). Use the TypeScript / Python switch at the top to change every code sample. Progress is saved in your browser.'));
}

function badgesPage() {
  return h('div', {},
    h('h1', {}, '🏅 Badges'),
    h('p', { class: 'lead' }, 'Most badges are unlocked by experimenting inside the simulators.'),
    h('div', { class: 'badges' }, Object.entries(BADGES).map(([id, b]) => h('div', { class: 'badge' + (Game.s.badges[id] ? '' : ' locked') },
      h('div', { class: 'i' }, b.icon), h('b', {}, b.name), h('small', {}, b.desc)))),
    h('p', {}, btn('Reset all progress', () => { if (confirm('Erase XP, badges and quiz progress?')) { Game.reset(); route(); } }, 'ghost')));
}

function modulePage(m) {
  const idx = MODULES.indexOf(m);
  const footer = h('div');
  const questionCount = m.sections.filter((s) => s.type === 'quiz').reduce((n, s) => n + s.questions.length, 0);
  const allCorrect = () => Array.from({ length: questionCount }, (_, i) => Game.s.answers[m.id + ':' + i]?.ok).every(Boolean);

  const drawFooter = () => {
    const nxt = MODULES[idx + 1], prv = MODULES[idx - 1];
    footer.replaceChildren(...[
      Game.s.done[m.id] ? h('div', { class: 'complete' }, h('b', {}, '🎉 Module complete!'), h('div', { class: 'fb' }, nxt ? 'Up next: ' + nxt.title : 'You finished the whole quest. Check your badges!')) : null,
      h('div', { class: 'footer-nav' },
        prv ? h('a', { class: 'btn ghost', href: '#/m/' + prv.id, style: 'text-decoration:none' }, '← ' + prv.title) : h('span'),
        nxt ? h('a', { class: 'btn', href: '#/m/' + nxt.id, style: 'text-decoration:none' }, nxt.title + ' →') : h('a', { class: 'btn', href: '#/badges', style: 'text-decoration:none' }, 'See badges 🏅'))].filter(Boolean));
  };
  const onAnswer = () => {
    if (allCorrect() && !Game.s.done[m.id]) {
      Game.s.done[m.id] = true; Game.save();
      Game.addXp(40, 'Module complete: ' + m.title);
      if (MODULES.every((x) => Game.s.done[x.id])) Game.badge('graduate');
    }
    drawFooter();
  };

  const page = h('div', {},
    h('h1', {}, m.icon + ' ' + m.title),
    h('div', { class: 'meta' }, h('span', { class: 'pill' }, 'Module ' + (idx + 1) + ' of ' + MODULES.length), h('span', { class: 'pill' }, '⏱ ' + m.time), h('span', { class: 'pill' }, '+40 XP on completion')));
  for (const s of m.sections) {
    if (s.type === 'html') page.append(h('div', { html: s.html }));
    else if (s.type === 'code') page.append(codeBlock({ ts: s.ts, py: s.py }, s.title));
    else if (s.type === 'widget') page.append(WIDGETS[s.name]());
    else if (s.type === 'quiz') page.append(quiz(m, s.questions, onAnswer));
  }
  if (DEEP[m.id]) {
    page.append(h('div', { class: 'callout key deeplink' }, h('b', { class: 't' }, '📚 Want to go deeper?'),
      'Under-the-hood mechanics, limits, and three real-world use cases (Medium → Hard → Hard) with complete, tested ' + (m.title.toLowerCase()) + ' code in TypeScript and Python. ',
      h('a', { class: 'btn', href: '#/m/' + m.id + '/deep', style: 'text-decoration:none;display:inline-block;margin-top:8px' }, DEEP[m.id].title + ' →')));
  }
  drawFooter();
  page.append(footer);
  return page;
}

function deepPage(m) {
  const d = DEEP[m.id], code = DEEP_CODE[m.id];
  const list = (tag, items) => h(tag, { html: items.map((x) => '<li>' + x + '</li>').join('') });
  const page = h('div', {},
    h('a', { class: 'btn ghost', href: '#/m/' + m.id, style: 'text-decoration:none;display:inline-block' }, '← Back to ' + m.title),
    h('h1', { style: 'margin-top:14px' }, '📚 ' + d.title),
    h('div', { class: 'meta' }, h('span', { class: 'pill' }, 'Deep dive'), h('span', { class: 'pill' }, '3 use cases: ' + d.cases.map((c) => c.level).join(' → '))),
    h('div', { class: 'callout tip' }, h('b', { class: 't' }, '✔ Verified'), d.verified + '. The code below is the exact code that passed those tests. Facts are cited in Sources at the bottom.'),
    h('div', { html: d.under }),
    h('h2', {}, 'Real-world use cases'),
    h('div', { class: 'cards' }, d.cases.map((c, i) => h('a', { class: 'card link', href: '#case-' + c.key, onclick: (e) => { e.preventDefault(); document.getElementById('case-' + c.key).open = true; document.getElementById('case-' + c.key).scrollIntoView(); } },
      h('span', { class: 'lvl ' + c.level.toLowerCase() }, c.level), h('h3', {}, (i + 1) + '. ' + c.title.split(':')[0]), h('p', {}, c.title.split(':').slice(1).join(':').trim())))));

  d.cases.forEach((c, i) => {
    const det = h('details', { class: 'case', id: 'case-' + c.key, open: i === 0 },
      h('summary', {}, h('span', { class: 'lvl ' + c.level.toLowerCase() }, c.level), ' ' + (i + 1) + '. ' + c.title),
      h('h3', {}, 'Scenario'), h('p', { html: c.scenario }),
      h('h3', {}, 'Why Temporal fits'), h('p', { html: c.why }),
      h('h3', {}, 'Design'), list('ol', c.design),
      h('h3', {}, 'Complete code'),
      codeBlock({ ts: code[c.key].ts, py: code[c.key].py }, 'Passes the test suite in examples/' + m.id + '/'),
      h('h3', {}, 'What the tests proved'), list('ul', c.tested),
      h('h3', {}, 'Pitfalls & lessons'), list('ul', c.pitfalls),
      h('h3', {}, 'Variations to try'), list('ul', c.variations));
    page.append(det);
  });

  page.append(h('div', { html: d.checklist }),
    h('h2', {}, 'Sources'),
    h('ul', {}, d.sources.map(([t, u]) => h('li', {}, h('a', { href: u, target: '_blank', rel: 'noopener' }, t)))),
    h('h2', {}, 'Deep-dive challenge'),
    quiz({ id: 'deep-' + m.id }, d.quiz, () => {
      const all = d.quiz.every((_, i) => Game.s.answers['deep-' + m.id + ':' + i]?.ok);
      if (all) Game.badge(d.badge);
    }));
  return page;
}

/* ---------- router ---------- */
function route() {
  const hash = location.hash || '#/';
  let page;
  if (hash.startsWith('#/m/')) {
    const [id, sub] = hash.slice(4).split('/');
    const m = MODULES.find((x) => x.id === id);
    page = !m ? homePage() : sub === 'deep' && DEEP[id] ? deepPage(m) : modulePage(m);
  } else if (hash === '#/badges') page = badgesPage();
  else page = homePage();
  main.replaceChildren(page);
  renderNav();
  document.body.classList.remove('menu-open');
  window.scrollTo(0, 0);
  const title = hash.startsWith('#/m/') ? MODULES.find((x) => x.id === hash.slice(4).split('/')[0])?.title : null;
  document.title = (title ? title + ' · ' : '') + 'Temporal Quest';
}

/* ---------- boot ---------- */
Game.load();
document.body.dataset.lang = Game.s.lang || 'ts';
document.querySelectorAll('.langs button').forEach((b) => {
  b.classList.toggle('on', b.dataset.l === document.body.dataset.lang);
  b.addEventListener('click', () => {
    document.body.dataset.lang = b.dataset.l;
    Game.s.lang = b.dataset.l; Game.save();
    document.querySelectorAll('.langs button').forEach((x) => x.classList.toggle('on', x === b));
  });
});
$('#menu').addEventListener('click', () => document.body.classList.toggle('menu-open'));
Game.onChange = () => { renderHeader(); renderNav(); };
window.addEventListener('hashchange', route);
renderHeader();
route();
