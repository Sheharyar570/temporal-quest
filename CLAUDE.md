# Temporal Quest

Interactive, gamified tutorial site for learning Temporal (Workflows, Activities, Schedules, Signals, Updates, Queries, Workers, patterns). Static HTML/CSS/JS, no build step, no framework, no runtime dependencies. Deployed to GitHub Pages from `main`.

## Layout

- `index.html`: loads every script by plain `<script>` tag. Order matters: `core.js`, `widgets.js`, `content.js`, then each `js/deep/<topic>.code.js` before its `<topic>.js`, then `main.js` last. Paths must stay relative (the site is served from a sub-path).
- `js/core.js`: `Game` store (XP, levels, badges in localStorage), `BADGES`, the `h()` DOM helper.
- `js/content.js`: the main lesson modules (`MODULES`) and their quizzes.
- `js/widgets.js`: interactive labs (`WIDGETS`).
- `js/deep/<topic>.js`: "Go deeper" page, defines `DEEP.<topic>` (title, badge, 3 cases ordered Medium/Hard/Hard, checklist, sources, 5-question quiz).
- `js/deep/<topic>.code.js`: GENERATED. Never edit by hand.
- `js/main.js`: hash router (`#/m/<id>`, `#/m/<id>/deep`, `#/badges`), rendering, nav.
- `examples/<topic>/{python,typescript}/`: the real code shown on the deep-dive pages, each with a test suite.
- `scripts/build-deep-code.js`: embeds the example files into `js/deep/*.code.js` (MANIFEST maps topic, use case, files).
- `scripts/browser-test.js`: real-Chrome Playwright smoke test.

## Rules

- Accuracy is the product. Every claim and code sample on the site must match the official Temporal docs or be proven by a test in `examples/`. When docs and SDK behaviour disagree, say so on the page rather than picking one silently.
- Never edit code shown on the site directly. Edit the file in `examples/`, run its tests, then regenerate: `node scripts/build-deep-code.js`.
- Adding a deep-dive topic: write verified examples and tests, add them to MANIFEST, create `js/deep/<topic>.js` and regenerate `.code.js`, add both script tags to `index.html` (before `main.js`), add a badge in `BADGES` (`js/core.js`), and add a "Go deeper" link in the module in `js/content.js`.
- Keep `main.js` free of `null` children: `replaceChildren` and `h()` children must be filtered (`.filter(Boolean)`) or the page shows a literal "null".
- Mobile: the layout is checked at 390px. Wide tables and inline code have overflow rules in `css/style.css`; keep them.
- No bundler, no npm dependency in the site itself. Do not add one.

## Run and test

Site (any static server):

    python3 -m http.server 8765      # open http://127.0.0.1:8765/

Browser test (needs Google Chrome and the server above running):

    npm i playwright-core && node scripts/browser-test.js

Example tests: see `examples/README.md` (Python: pytest; TypeScript: tsc then `node dist/test.js`). They download Temporal test servers on first run and use real timers, so allow a minute or two.

## Deploy

`.github/workflows/deploy-pages.yml` publishes `index.html`, `css/`, `js/` to GitHub Pages on every push or merge to `main`. One-time repo setting: Settings, Pages, Source = GitHub Actions.
