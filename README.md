# ⏳ Temporal Quest

An interactive, gamified tutorial for learning [Temporal](https://docs.temporal.io/): Workflows, Activities, Signals, Updates, Queries, Workers, Schedules and the patterns built on them.

Earn XP, level up, unlock badges, break things in the labs, and pass the quizzes. Every topic has a **Go deeper** page with three real-world use cases (Medium, Hard, Hard) in both TypeScript and Python.

## Features

- Short lessons with quizzes and interactive labs (crash a worker, send signals, queries and updates, watch schedule overlap policies).
- Seven in-depth pages, each with a design walk-through, pitfalls, a checklist, source links and a quiz.
- TypeScript / Python toggle with copy buttons and syntax highlighting.
- Progress (XP, levels, 19 badges) saved in your browser's localStorage. No account, no server.
- Works on desktop and phone, light and dark.

## Every example is tested

The code on the deep-dive pages is not hand-written for display. It lives in [`examples/`](examples/), runs against a real Temporal server in each SDK's test suite, and is embedded into the site by a script, so the docs cannot drift from the tested code.

Verified against `temporalio` (Python) 1.34.0 and `@temporalio/*` (TypeScript) 1.24.0. Where the docs and the SDK disagree, the page says so. See [`examples/README.md`](examples/README.md) for how to run the tests.

## Run locally

No build step. Serve the folder with any static server:

    python3 -m http.server 8765

Then open http://127.0.0.1:8765/.

## Project layout

    index.html              entry point, loads scripts in order
    css/style.css           styles (light/dark, mobile rules)
    js/core.js              progress store, badges, DOM helper
    js/content.js           lesson modules and quizzes
    js/widgets.js           interactive labs
    js/main.js              hash router and rendering
    js/deep/                "Go deeper" pages (*.js) and generated code (*.code.js)
    examples/               tested Python and TypeScript examples per topic
    scripts/                code embedder and real-browser test

## Contributing

- Edit code samples in `examples/`, run their tests, then regenerate the embedded copies:

      node scripts/build-deep-code.js

  Never edit `js/deep/*.code.js` by hand.
- Check the site in a real browser (needs Google Chrome):

      npm i playwright-core
      python3 -m http.server 8765 &
      node scripts/browser-test.js

- See [`CLAUDE.md`](CLAUDE.md) (also linked as `AGENTS.md`) for conventions, aimed at AI coding agents and equally useful to people.

## Deployment

Pushing or merging to `main` runs [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml), which publishes `index.html`, `css/` and `js/` to GitHub Pages.

One-time setup: in the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.

The site uses only relative paths, so it works under a project URL such as `https://<user>.github.io/<repo>/`.

## Not covered yet

Tested in Chrome only (not Firefox or Safari), at desktop and phone widths. No screen-reader or keyboard-only audit.
