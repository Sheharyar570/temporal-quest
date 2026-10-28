# Verified examples

Every use case shown in a "Go deeper" page lives here as real code with a test suite.
`scripts/build-deep-code.js` embeds these exact files into the site, so docs and tests cannot drift.

Verified on 2026-10-27 (workflows: 2026-10-28) against `temporalio` (Python) 1.34.0 and `@temporalio/*` (TypeScript) 1.24.0.
The SDKs download the test servers automatically on first run:
- `signals/`: time-skipping test server (timers fast-forward)
- `updates/`, `queries/` and `activities/`: local dev server (Temporal CLI 1.9.1 / server 1.32.0). I did not test whether the time-skipping server supports updates.
- `workflows/`: both. The 14-day trial timers use the time-skipping server; everything involving replay, patching, children and Continue-As-New uses the local dev server. A query sent to a freshly started second worker timed out on the time-skipping server, so that test runs on the dev server (not investigated).

## Run the tests (shown for `signals`; use `updates` / `queries` / `activities` / `workflows` / `workers` / `schedules` the same way)

Python:

    cd examples/signals/python
    python3 -m venv .venv && .venv/bin/pip install temporalio pytest pytest-asyncio
    .venv/bin/python -m pytest -q          # signals: 7 tests, updates: 6, queries: 3, activities: 13, workflows: 13, workers: 9, schedules: 16 (~40–80 s: real timers)

TypeScript:

    cd examples/signals/typescript
    npm i @temporalio/client @temporalio/worker @temporalio/workflow @temporalio/activity \
          @temporalio/testing @temporalio/common typescript @types/node
    npx tsc --target ES2022 --module commonjs --strict --esModuleInterop --skipLibCheck --outDir dist *.ts
    node dist/test.js                      # signals: 7 tests, updates: 4 groups, queries: 4 groups, activities: 13
    # (updates also needs: npm i async-mutex; queries and activities also need: npm i @temporalio/proto)

## After editing an example

    node scripts/build-deep-code.js        # regenerates js/deep/<topic>.code.js

## Notes for `workers/`
- Needs a local dev server. Python: each simulated host gets its own `Runtime`. TypeScript: hosts and the crashing worker are child processes; the test binds the dev server to port 17233 and Prometheus metrics to 9465 (Python: 9464), so free those ports first.
- Metrics tests read `temporal_*` series from the SDK's own Prometheus endpoint.

## Notes for `schedules/`
- Needs a local dev server and real time (Schedules don't run on the time-skipping server). The whole suite takes about 1.5 minutes per language.
- Findings the tests pin down: scheduled workflow IDs are base + timestamp to the second, so two schedules with the same base can collide silently; TypeScript's bare `trigger()` runs as `ALLOW_ALL` (pass the policy explicitly); and runs started that way fed no last-completion-result and did not trigger pause-on-failure.
