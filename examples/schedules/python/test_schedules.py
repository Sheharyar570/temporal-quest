"""Verification harness: runs each use case against a real local Temporal dev server (real time: Schedules need it)."""
import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from temporalio.client import (
    Client, ScheduleBackfill, ScheduleOverlapPolicy as P, ScheduleIntervalSpec, ScheduleSpec, ScheduleUpdate,
    ScheduleActionStartWorkflow, WorkflowExecutionStatus as St,
)
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import overlap
import report
import sync


@pytest.fixture(scope="module")
async def env():
    async with await WorkflowEnvironment.start_local() as e:
        yield e


def uid(p):
    return f"{p}-{uuid.uuid4().hex[:6]}"


async def until(cond, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if await cond():
            return
        await asyncio.sleep(0.2)
    raise AssertionError("condition not met")


async def actions(handle):
    """Workflow IDs of the runs the schedule has started, oldest first."""
    d = await handle.describe()
    return [a.action.workflow_id for a in sorted(d.info.recent_actions, key=lambda a: a.scheduled_at)]


async def status(client, wid):
    return (await client.get_workflow_handle(wid).describe()).status


# ============================================================ use case 1: daily report
async def test_calendar_in_a_time_zone_and_default_fields(env):
    sid = uid("cal")
    await report.create(env.client, sid)
    d = await env.client.get_schedule_handle(sid).describe()
    ny = ZoneInfo("America/New_York")
    assert len(d.info.next_action_times) >= 3
    for t in d.info.next_action_times:
        local = t.astimezone(ny)
        assert (local.hour, local.minute, local.second) == (9, 0, 0), local  # 09:00 New York, DST-aware; minute defaults to 0
    print("next runs (UTC):", [t.strftime("%m-%d %H:%M") for t in d.info.next_action_times[:5]])
    await env.client.get_schedule_handle(sid).delete()


async def test_trigger_run_ids_search_attributes_and_pause_semantics(env):
    async with Worker(env.client, task_queue=report.TASK_QUEUE, workflows=[report.ReportWorkflow]):
        sid = uid("trig")
        await report.create(env.client, sid)
        h = env.client.get_schedule_handle(sid)
        await h.trigger()
        await until(lambda: _n(h, 1))
        (wid,) = await actions(h)
        assert wid.startswith(f"report-{sid}-")  # base ID + the action's timestamp
        wf = env.client.get_workflow_handle(wid)
        out = await wf.result()
        assert out.startswith("emea report for ")  # the workflow could read its scheduled start time
        attrs = (await wf.describe()).typed_search_attributes
        by_name = {k.name: v for k, v in attrs}
        assert by_name["TemporalScheduledById"] == sid
        assert "TemporalScheduledStartTime" in by_name
        await h.delete()


async def _n(h, n):
    return (await h.describe()).info.num_actions >= n


async def test_pause_stops_the_spec_but_not_manual_triggers_or_runs_in_flight(env):
    async with Worker(env.client, task_queue=report.TASK_QUEUE, workflows=[report.ReportWorkflow]):
        sid = uid("pause")
        sched = report.daily_schedule(sid, "emea", seconds_of_work=3)
        sched.spec = ScheduleSpec(intervals=[ScheduleIntervalSpec(every=timedelta(seconds=1))])
        await env.client.create_schedule(sid, sched)
        h = env.client.get_schedule_handle(sid)
        await until(lambda: _n(h, 1))
        await h.pause(note="maintenance")
        n_at_pause = (await h.describe()).info.num_actions
        first = (await actions(h))[0]
        await asyncio.sleep(3.5)
        d = await h.describe()
        assert d.info.num_actions == n_at_pause  # nothing new while paused
        assert d.schedule.state.paused and d.schedule.state.note == "maintenance"
        assert await status(env.client, first) == St.COMPLETED  # the run already in flight was not touched
        await h.trigger()  # manual runs still work while paused
        await until(lambda: _n(h, n_at_pause + 1))
        await h.unpause()
        n = (await h.describe()).info.num_actions
        await until(lambda: _n(h, n + 1))  # the spec is live again
        await h.delete()


async def test_update_changes_the_arguments_of_future_runs(env):
    async with Worker(env.client, task_queue=report.TASK_QUEUE, workflows=[report.ReportWorkflow]):
        sid = uid("upd")
        await report.create(env.client, sid, "emea")
        h = env.client.get_schedule_handle(sid)

        async def to_apac(inp):
            act = inp.description.schedule.action
            assert isinstance(act, ScheduleActionStartWorkflow)
            act.args = ["apac", 0]
            return ScheduleUpdate(schedule=inp.description.schedule)

        await h.update(to_apac)
        await h.trigger()
        await until(lambda: _n(h, 1))
        (wid,) = await actions(h)
        assert (await env.client.get_workflow_handle(wid).result()).startswith("apac report")
        await h.delete()


async def test_limited_actions_stop_after_n_runs(env):
    async with Worker(env.client, task_queue=report.TASK_QUEUE, workflows=[report.ReportWorkflow]):
        sid = uid("lim")
        sched = report.daily_schedule(sid, "emea")
        sched.spec = ScheduleSpec(intervals=[ScheduleIntervalSpec(every=timedelta(seconds=1))])
        sched.state.limited_actions = True
        sched.state.remaining_actions = 2
        await env.client.create_schedule(sid, sched)
        h = env.client.get_schedule_handle(sid)
        await until(lambda: _n(h, 2))
        await asyncio.sleep(3)
        d = await h.describe()
        assert d.info.num_actions == 2 and d.schedule.state.remaining_actions == 0
        print("after limit: paused =", d.schedule.state.paused, "remaining =", d.schedule.state.remaining_actions)
        await h.delete()


async def test_deleting_a_schedule_does_not_touch_the_runs_it_started(env):
    async with Worker(env.client, task_queue=report.TASK_QUEUE, workflows=[report.ReportWorkflow]):
        sid = uid("del")
        await env.client.create_schedule(sid, report.daily_schedule(sid, "emea", seconds_of_work=3))
        h = env.client.get_schedule_handle(sid)
        await h.trigger()
        await until(lambda: _n(h, 1))
        (wid,) = await actions(h)
        await h.delete()
        assert await status(env.client, wid) == St.RUNNING
        assert (await env.client.get_workflow_handle(wid).result()).startswith("emea report")
        with pytest.raises(Exception):
            await h.describe()


async def test_two_schedules_sharing_a_workflow_id_base_can_collide_and_one_run_silently_never_starts(env):
    async with Worker(env.client, task_queue=report.TASK_QUEUE, workflows=[report.ReportWorkflow]):
        seen = []
        for attempt in range(5):
            sids = [uid("col"), uid("col")]
            for s in sids:
                sched = report.daily_schedule(s, "emea")
                sched.action.id = "report-shared"  # the mistake: the same base for both
                await env.client.create_schedule(s, sched)
            hs = [env.client.get_schedule_handle(s) for s in sids]
            await asyncio.sleep(1 - (time.time() % 1) + 0.05)  # start of a fresh second, so both fire inside it
            await asyncio.gather(*[h.trigger() for h in hs])
            await asyncio.sleep(3)
            counts = [(await h.describe()).info.num_actions for h in hs]
            ids = [i for h in hs for i in await actions(h)]
            for h in hs:
                await h.delete()
            seen.append((counts, ids))
            if sorted(counts) == [0, 1]:
                break
        print("collision attempts:", seen)
        assert sorted(seen[-1][0]) == [0, 1]  # one schedule's run never started; no error, no skip counter
        assert len(seen[-1][1]) == 1


# ============================================================ use case 2: overlap policies
async def run_policy(env, policy):
    sid = uid(policy.name.lower())
    async with Worker(env.client, task_queue=overlap.TASK_QUEUE, workflows=[overlap.SlowJob]):
        await overlap.create(env.client, sid, policy, seconds=4)
        h = env.client.get_schedule_handle(sid)
        for _ in range(3):  # t = 0 s, 1 s, 2 s: each trigger arrives while the previous run is still going
            await h.trigger()
            await asyncio.sleep(1)

        async def quiet():
            d = await h.describe()
            return not d.info.running_actions and d.info.num_actions + d.info.num_actions_skipped_overlap >= 1
        await until(quiet, timeout=40)
        await asyncio.sleep(1.5)  # let a buffered run that hasn't been picked up yet show itself
        await until(quiet, timeout=40)

        async def all_closed():
            return all([await status(env.client, w) != St.RUNNING for w in await actions(h)])
        await until(all_closed, timeout=40)
        d = await h.describe()
        ids = await actions(h)
        runs = []
        for wid in ids:
            desc = await env.client.get_workflow_handle(wid).describe()
            runs.append((desc.start_time, desc.close_time, desc.status))
        starts = sorted(r[0] for r in runs)
        # peak concurrency from start/close times
        far = datetime.max.replace(tzinfo=timezone.utc)
        peak = max(sum(1 for s, e, _ in runs if s <= t < (e or far)) for t, _, _ in runs) if runs else 0
        await h.delete()
        return dict(started=d.info.num_actions, skipped=d.info.num_actions_skipped_overlap,
                    statuses=sorted(r[2].name for r in runs), peak=peak)


@pytest.mark.parametrize("policy,expect", [
    (P.SKIP, dict(started=1, skipped=2, statuses=["COMPLETED"], peak=1)),
    (P.BUFFER_ONE, dict(started=2, statuses=["COMPLETED", "COMPLETED"], peak=1)),
    (P.BUFFER_ALL, dict(started=3, statuses=["COMPLETED"] * 3, peak=1)),
    (P.CANCEL_OTHER, dict(started=3, statuses=["CANCELED", "CANCELED", "COMPLETED"], peak=1)),
    (P.TERMINATE_OTHER, dict(started=3, statuses=["COMPLETED", "TERMINATED", "TERMINATED"], peak=1)),
    (P.ALLOW_ALL, dict(started=3, statuses=["COMPLETED"] * 3, peak=3)),
])
async def test_overlap_policy(env, policy, expect):
    got = await run_policy(env, policy)
    print(policy.name, got)
    for k, v in expect.items():
        assert got[k] == v, (policy.name, k, got)


# ============================================================ use case 3: incremental sync
def sync_worker(client):
    return Worker(client, task_queue=sync.TASK_QUEUE, workflows=[sync.SyncWorkflow], activities=[sync.sync_rows])


async def trigger_and_wait(env, h, n):
    await h.trigger()
    await until(lambda: _n(h, n))
    wid = (await actions(h))[-1]
    try:
        return await env.client.get_workflow_handle(wid, result_type=sync.SyncResult).result(), wid
    except Exception as e:
        return e, wid


async def test_last_completion_result_is_a_watermark_and_a_failed_run_does_not_move_it(env):
    sync.source.__init__()
    async with sync_worker(env.client):
        sid = uid("wm")
        await sync.create(env.client, sid, every=timedelta(days=1), paused=True)
        h = env.client.get_schedule_handle(sid)
        r1, _ = await trigger_and_wait(env, h, 1)
        assert (r1.watermark, r1.previous_run_failed) == (5, False)
        assert sync.source.processed == [1, 2, 3, 4, 5]

        sync.source.rows += [6, 7, 8]
        r2, _ = await trigger_and_wait(env, h, 2)
        assert r2.watermark == 8
        assert sync.source.processed == [1, 2, 3, 4, 5, 6, 7, 8]  # run 2 saw only the 3 new rows

        sync.source.up = False
        sync.source.rows += [9]
        r3, _ = await trigger_and_wait(env, h, 3)
        assert isinstance(r3, Exception)  # failed: no new result recorded

        sync.source.up = True
        r4, _ = await trigger_and_wait(env, h, 4)
        assert r4.watermark == 9 and r4.previous_run_failed is True  # resumed from 8, and it could see the failure
        assert sync.source.processed == list(range(1, 10))

        r5, _ = await trigger_and_wait(env, h, 5)
        assert r5.previous_run_failed is False  # a success resets the last failure
        await h.delete()


async def test_pause_on_failure_pauses_for_failures_but_not_for_cancel_or_terminate(env):
    sync.source.__init__()
    async with sync_worker(env.client):
        # a failed run pauses the schedule
        sid = uid("pof")
        await sync.create(env.client, sid, every=timedelta(days=1), pause_on_failure=True)
        h = env.client.get_schedule_handle(sid)
        sync.source.up = False
        await h.trigger()
        await until(lambda: _n(h, 1))

        async def paused():
            return (await h.describe()).schedule.state.paused
        await until(paused)
        print("paused note:", (await h.describe()).schedule.state.note)
        await h.delete()

        # cancel and terminate do not
        sync.source.up = True
        for how in ("cancel", "terminate"):
            sid = uid("pof-" + how)
            await sync.create(env.client, sid, every=timedelta(days=1), pause_on_failure=True, mode="hang")
            h = env.client.get_schedule_handle(sid)
            await h.trigger()
            await until(lambda: _n(h, 1))
            wf = env.client.get_workflow_handle((await actions(h))[-1])
            await (wf.cancel() if how == "cancel" else wf.terminate())
            await until(lambda: _closed(wf))
            await asyncio.sleep(1.5)
            assert not (await h.describe()).schedule.state.paused, how
            await h.delete()


async def _closed(wf):
    return (await wf.describe()).status != St.RUNNING


async def test_backfill_runs_the_missed_slots_with_their_scheduled_times(env):
    sync.source.__init__()
    async with sync_worker(env.client):
        sid = uid("bf")
        await sync.create(env.client, sid, every=timedelta(minutes=1), paused=True)  # paused: only the backfill runs
        h = env.client.get_schedule_handle(sid)
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        await h.backfill(ScheduleBackfill(start_at=now - timedelta(minutes=5), end_at=now - timedelta(seconds=1), overlap=P.ALLOW_ALL))
        await until(lambda: _n(h, 5), timeout=20)
        await asyncio.sleep(1)
        ids = await actions(h)
        times = []
        for wid in ids:
            attrs = (await env.client.get_workflow_handle(wid).describe()).typed_search_attributes
            times.append(next(v for k, v in attrs if k.name == "TemporalScheduledStartTime"))
        times.sort()
        print("backfill slots:", [t.strftime("%H:%M:%S") for t in times], "ids unique:", len(set(ids)) == len(ids))
        assert len(ids) == 5 and len(set(ids)) == 5  # one run per missed slot, each with its own ID
        assert times == [now - timedelta(minutes=m) for m in (5, 4, 3, 2, 1)]  # start inclusive, each slot's own time
        assert (await h.describe()).schedule.state.paused  # the schedule itself stayed paused
        await h.delete()
