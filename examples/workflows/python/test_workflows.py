"""Verification harness: runs each use case against a real Temporal test server."""
import asyncio
import uuid
from datetime import datetime, timedelta

import pytest
from temporalio import workflow
from temporalio.api.enums.v1 import EventType
from temporalio.client import WorkflowExecutionStatus as St
from temporalio.common import WorkflowIDConflictPolicy as Conflict, WorkflowIDReusePolicy as Reuse
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Replayer, Worker

import import_job as imp
import order
import trial


@pytest.fixture(scope="module")
async def skip_env():
    async with await WorkflowEnvironment.start_time_skipping() as e:
        yield e


@pytest.fixture(scope="module")
async def env():
    async with await WorkflowEnvironment.start_local() as e:
        yield e


def uid(p):
    return f"{p}-{uuid.uuid4().hex[:6]}"


def types(history):
    return [EventType.Name(e.event_type) for e in history.events]


async def until(cond, timeout=20):
    end = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < end:
        if await cond():
            return
        await asyncio.sleep(0.1)
    raise AssertionError("condition not met")


# ============================================================ use case 1: trial
@workflow.defn(name="TrialWorkflow")
class Skips:  # same type name, but no longer sends the welcome email first
    @workflow.run
    async def run(self, req: trial.TrialRequest) -> str:
        await workflow.sleep(timedelta(days=req.reminder_after_days))
        return "x"


@workflow.defn
class Bad:
    @workflow.run
    async def run(self) -> str:
        return datetime.now().isoformat()


def trial_worker(client, wf=trial.TrialWorkflow):
    return Worker(client, task_queue=trial.TASK_QUEUE, workflows=[wf], activities=[trial.send_email])


def kinds():
    return [k for _, k in trial.SENT]


async def start_trial(client, **kw):
    trial.SENT.clear()
    return await client.start_workflow(trial.TrialWorkflow.run, trial.TrialRequest("u1"), id=uid("trial"),
                                       task_queue=trial.TASK_QUEUE, **kw)


async def test_trial_expires_after_14_days_in_seconds(skip_env):
    async with trial_worker(skip_env.client):
        t0 = asyncio.get_event_loop().time()
        h = await start_trial(skip_env.client)
        assert await h.result() == "expired"
        assert kinds() == ["welcome", "reminder", "expired"]
        assert asyncio.get_event_loop().time() - t0 < 10  # 14 simulated days


async def test_trial_conversion_cancels_the_pending_timer_path(skip_env):
    async with trial_worker(skip_env.client):
        h = await start_trial(skip_env.client)
        await skip_env.sleep(timedelta(days=12))  # past the reminder, still inside the trial
        await h.signal(trial.TrialWorkflow.convert)
        assert await h.result() == "converted"
        assert kinds() == ["welcome", "reminder", "thanks"]


async def test_replay_of_a_real_history_succeeds_and_clock_and_uuid_are_stable(env):
    async with trial_worker(env.client):
        h = await start_trial(env.client)
        before = await h.query(trial.TrialWorkflow.ends_at)
    # worker stopped: the next one has no memory of the first; it rebuilds state by replaying history
    async with trial_worker(env.client):
        after = await h.query(trial.TrialWorkflow.ends_at)
        assert before == after and before != ""
        await h.signal(trial.TrialWorkflow.convert)
        await h.result()
    history = await h.fetch_history()
    await Replayer(workflows=[trial.TrialWorkflow]).replay_workflow(history)  # raises on any divergence
    assert types(history).count("EVENT_TYPE_TIMER_STARTED") >= 1


async def test_changing_the_order_of_commands_is_a_nondeterminism_error(skip_env):
    async with trial_worker(skip_env.client):
        h = await start_trial(skip_env.client)
        await skip_env.sleep(timedelta(days=1))
        await h.signal(trial.TrialWorkflow.convert)
        await h.result()
    history = await h.fetch_history()
    with pytest.raises(workflow.NondeterminismError):
        await Replayer(workflows=[Skips]).replay_workflow(history)


async def test_reading_the_wall_clock_in_a_workflow_is_blocked_by_the_sandbox(env):
    async with Worker(env.client, task_queue="bad", workflows=[Bad]):
        h = await env.client.start_workflow(Bad.run, id=uid("bad"), task_queue="bad")
        await until(lambda: _has(h, "EVENT_TYPE_WORKFLOW_TASK_FAILED"))
        assert (await h.describe()).status == St.RUNNING  # a bug blocks the workflow; it does not fail it
        failed = [e for e in (await h.fetch_history()).events if e.event_type == EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED]
        assert "RestrictedWorkflowAccessError" in failed[0].workflow_task_failed_event_attributes.failure.message \
            or "RestrictedWorkflowAccessError" in failed[0].workflow_task_failed_event_attributes.failure.stack_trace
        await h.terminate()


async def _has(h, name):
    return name in types(await h.fetch_history())


async def test_workflow_id_policies(skip_env):
    c = skip_env.client
    async with trial_worker(c):
        h = await start_trial(c)
        wid = h.id

        async def again(**kw):
            return await c.start_workflow(trial.TrialWorkflow.run, trial.TrialRequest("u1"), id=wid,
                                          task_queue=trial.TASK_QUEUE, **kw)

        with pytest.raises(WorkflowAlreadyStartedError):  # default conflict policy: FAIL
            await again()
        same = await again(id_conflict_policy=Conflict.USE_EXISTING)
        assert same.result_run_id == h.result_run_id  # no second run was started
        replaced = await again(id_conflict_policy=Conflict.TERMINATE_EXISTING)
        assert replaced.result_run_id != h.result_run_id
        assert (await c.get_workflow_handle(wid, run_id=h.result_run_id).describe()).status == St.TERMINATED

        await replaced.signal(trial.TrialWorkflow.convert)
        assert await replaced.result() == "converted"
        with pytest.raises(WorkflowAlreadyStartedError):  # closed + COMPLETED
            await again(id_reuse_policy=Reuse.REJECT_DUPLICATE)
        with pytest.raises(WorkflowAlreadyStartedError):
            await again(id_reuse_policy=Reuse.ALLOW_DUPLICATE_FAILED_ONLY)
        third = await again()  # default ALLOW_DUPLICATE
        assert third.result_run_id not in (h.result_run_id, replaced.result_run_id)
        await third.terminate()


# ============================================================ use case 2: patching
def order_worker(client, wf):
    return Worker(client, task_queue=order.TASK_QUEUE, workflows=[wf], activities=[order.charge, order.fraud_check, order.ship])


async def start_order(client):
    return await client.start_workflow("OrderWorkflow", "o", id=uid("order"), task_queue=order.TASK_QUEUE)


async def test_patching_lifecycle(env):
    c = env.client
    order.CALLS.clear()
    # an order started under v1 and left open (waiting for the "packed" signal)
    async with order_worker(c, order.OrderV1):
        old = await start_order(c)
        await until(lambda: settled(old))
    h_old = await old.fetch_history()

    # replay tests, no server needed beyond the history
    await Replayer(workflows=[order.OrderV2Patched]).replay_workflow(h_old)  # patched code accepts the old history
    with pytest.raises(workflow.NondeterminismError):
        await Replayer(workflows=[order.OrderV2Naive]).replay_workflow(h_old)  # the unpatched change would not

    # deploy v2 for real: the OLD execution carries on without the fraud check, a NEW one gets it
    order.CALLS.clear()
    async with order_worker(c, order.OrderV2Patched):
        await old.signal("packed_signal")
        assert await old.result() == "shipped"
        assert order.CALLS == ["ship"]  # no fraud_check for the order that started before the patch
        new = await start_order(c)
        await until(lambda: settled(new))
        await new.signal("packed_signal")
        assert await new.result() == "shipped"
        assert order.CALLS == ["ship", "fraud_check", "charge", "ship"]
    h_new = await new.fetch_history()
    markers = [e for e in h_new.events if e.event_type == EventType.EVENT_TYPE_MARKER_RECORDED]
    assert len(markers) == 1 and markers[0].marker_recorded_event_attributes.marker_name == "core_patch"

    # step 2: deprecate. Histories that HAVE the marker still replay...
    await Replayer(workflows=[order.OrderV3Deprecated]).replay_workflow(h_new)
    # ...but histories from before the patch do not: this is why you wait for old executions to finish first
    with pytest.raises(workflow.NondeterminismError):
        await Replayer(workflows=[order.OrderV3Deprecated]).replay_workflow(h_old)


async def _calls(name):
    return name in order.CALLS


async def settled(h):  # charge finished AND its workflow task completed, so the history has the "waiting" point
    return types(await h.fetch_history()).count("EVENT_TYPE_WORKFLOW_TASK_COMPLETED") >= 2


async def test_deploying_the_unpatched_change_blocks_the_open_execution(env):
    c = env.client
    order.CALLS.clear()
    async with order_worker(c, order.OrderV1):
        old = await start_order(c)
        await until(lambda: settled(old))
    async with order_worker(c, order.OrderV2Naive):
        await old.signal("packed_signal")
        await until(lambda: _has(old, "EVENT_TYPE_WORKFLOW_TASK_FAILED"))
        assert (await old.describe()).status == St.RUNNING  # stuck, not failed
        failure = [e for e in (await old.fetch_history()).events if e.event_type == EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED][0]
        assert "nondeterminism" in failure.workflow_task_failed_event_attributes.failure.message.lower()
    # roll back the code and the same execution recovers
    async with order_worker(c, order.OrderV1):
        assert await old.result() == "shipped"


# ============================================================ use case 3: children + continue-as-new
def import_worker(client, max_cached=None):
    return Worker(client, task_queue=imp.TASK_QUEUE, workflows=[imp.ImportWorkflow, imp.PageWorkflow],
                  activities=[imp.import_page])


async def run_import(c, job, **kw):
    imp.DONE.clear()
    return await c.start_workflow(imp.ImportWorkflow.run, imp.ImportInput(job, **kw), id=job, task_queue=imp.TASK_QUEUE)


async def test_import_spans_several_runs_and_every_page_is_processed_once(env):
    async with import_worker(env.client):
        job = uid("job")
        h = await run_import(env.client, job)
        assert await h.result() == 100
        assert sorted(imp.DONE) == list(range(10))
        events = (await env.client.get_workflow_handle(job).fetch_history()).events  # latest run
        assert types(await env.client.get_workflow_handle(job).fetch_history()).count("EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW") == 0
        first = await env.client.get_workflow_handle(job, run_id=h.first_execution_run_id).describe()
        assert first.status == St.CONTINUED_AS_NEW  # the run we started was not the last
        # the three runs had two children batches each at most: history of the last run is small
        assert len(events) < 60
        for p in range(10):
            d = await env.client.get_workflow_handle(f"{job}-page-{p}").describe()
            assert d.status == St.COMPLETED


async def test_without_continue_as_new_one_run_history_is_much_longer(env):
    async with import_worker(env.client):
        a = await run_import(env.client, uid("a"), pages_per_run=2)  # many runs
        await a.result()
        n_small = len((await env.client.get_workflow_handle(a.id).fetch_history()).events)
        b = await run_import(env.client, uid("b"), pages_per_run=1000)  # never continues
        await b.result()
        n_big = len((await env.client.get_workflow_handle(b.id).fetch_history()).events)
        assert n_big > n_small * 2


async def test_parent_close_policy_decides_what_happens_to_running_children(env):
    async with import_worker(env.client):
        expected = {"TERMINATE": St.TERMINATED, "REQUEST_CANCEL": St.CANCELED, "ABANDON": St.COMPLETED}
        for policy, child_status in expected.items():
            job = uid(policy.lower())
            h = await run_import(env.client, job, page_delay=3.0, parent_close=policy)
            child = env.client.get_workflow_handle(f"{job}-page-0")

            async def running():
                try:
                    return (await child.describe()).status == St.RUNNING
                except Exception:
                    return False
            await until(running)
            await h.terminate()  # the parent closes abruptly
            await until(lambda: _not_running(child))
            assert (await child.describe()).status == child_status, policy
            await asyncio.sleep(3.2)  # let any abandoned child's activity drain before the next loop


async def _not_running(child):
    return (await child.describe()).status != St.RUNNING


async def test_cancelling_the_parent_cancels_its_children(env):
    async with import_worker(env.client):
        job = uid("cancel")
        h = await run_import(env.client, job, page_delay=3.0)
        child = env.client.get_workflow_handle(f"{job}-page-0")

        async def running():
            try:
                return (await child.describe()).status == St.RUNNING
            except Exception:
                return False
        await until(running)
        await h.cancel()
        await until(lambda: _not_running(child))
        assert (await child.describe()).status == St.CANCELED
        assert (await h.describe()).status == St.CANCELED


async def test_appending_a_step_where_old_executions_wait_is_not_caught_by_replay_of_an_open_history(env):
    c = env.client
    order.CALLS.clear()
    async with order_worker(c, order.OrderV1):
        old = await start_order(c)
        await until(lambda: settled(old))
        open_history = await old.fetch_history()
    # no later command in the history contradicts the new code, so replay is happy...
    await Replayer(workflows=[order.OrderV2Appended]).replay_workflow(open_history)
    # ...and in production the open execution silently runs the new step (after the signal, not where the new code puts it)
    async with order_worker(c, order.OrderV2Appended):
        await old.signal("packed_signal")
        assert await old.result() == "shipped"
    assert order.CALLS == ["charge", "fraud_check", "ship"]
    assert "EVENT_TYPE_WORKFLOW_TASK_FAILED" not in types(await old.fetch_history())
    # a COMPLETED v1 history does contain later commands, and replaying that one does catch it
    order.CALLS.clear()
    async with order_worker(c, order.OrderV1):
        done = await start_order(c)
        await until(lambda: settled(done))
        await done.signal("packed_signal")
        await done.result()
    with pytest.raises(workflow.NondeterminismError):
        await Replayer(workflows=[order.OrderV2Appended]).replay_workflow(await done.fetch_history())
