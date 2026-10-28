"""Verification harness: runs each use case against a real local Temporal dev server."""
import asyncio
import time
import uuid
from datetime import timedelta

import pytest
from temporalio import activity, workflow
from temporalio.api.enums.v1 import EventType
from temporalio.client import WorkflowFailureError
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError, CancelledError, TimeoutError, TimeoutType
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import export
import fanout
import payments


@pytest.fixture(scope="module")
async def env():
    async with await WorkflowEnvironment.start_local() as e:
        yield e


def uid(p):
    return f"{p}-{uuid.uuid4().hex[:6]}"


# ============================================================ use case 1: payments
@pytest.fixture
async def pay(env):
    payments.provider.__init__()
    return Worker(env.client, task_queue=payments.TASK_QUEUE, workflows=[payments.CheckoutWorkflow],
                  activities=[payments.charge_card])


LAST = {}


async def checkout(env, **kw):
    req = payments.CheckoutRequest(uid("o"), 100, "tok", **kw)
    LAST["id"] = req.order_id
    return await env.client.execute_workflow(payments.CheckoutWorkflow.run, req, id=req.order_id,
                                             task_queue=payments.TASK_QUEUE)


async def test_transient_failures_are_retried_with_exponential_backoff(env, pay):
    payments.provider.script = ["fail_before", "fail_before", "fail_before", "ok"]
    async with pay:
        assert await checkout(env) == "paid:ch_1:attempt4"
    t = payments.provider.calls
    gaps = [b - a for a, b in zip(t, t[1:])]
    assert len(gaps) == 3
    for gap, expected in zip(gaps, (1, 2, 4)):                          # initial_interval * 2^n: 1s, 2s, 4s
        assert expected - 0.05 <= gap <= expected + 0.7, gaps
    # three failed attempts left no events of their own: retries live in the server, not in history.
    # Only ONE Started event exists, written when the activity closed, and it records the final attempt number.
    events = (await env.client.get_workflow_handle(LAST["id"]).fetch_history()).events
    types = [e.event_type for e in events]
    assert types.count(EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED) == 1
    assert types.count(EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED) == 1
    assert types.count(EventType.EVENT_TYPE_ACTIVITY_TASK_COMPLETED) == 1
    assert EventType.EVENT_TYPE_ACTIVITY_TASK_FAILED not in types
    started = next(e for e in events if e.event_type == EventType.EVENT_TYPE_ACTIVITY_TASK_STARTED)
    assert started.activity_task_started_event_attributes.attempt == 4


async def test_lost_response_is_retried_without_double_charging(env, pay):
    payments.provider.script = ["fail_after", "ok"]   # the charge succeeds, the answer is lost
    async with pay:
        assert await checkout(env) == "paid:ch_1:attempt2"
    assert len(payments.provider.charges) == 1        # same idempotency key => ONE charge


async def test_non_retryable_decline_is_not_retried(env, pay):
    payments.provider.script = ["decline"]
    async with pay:
        assert await checkout(env) == "declined"
    assert len(payments.provider.calls) == 1


async def test_next_retry_delay_overrides_backoff(env, pay):
    payments.provider.script = ["rate_limit:3", "ok"]
    async with pay:
        assert await checkout(env) == "paid:ch_1:attempt2"
    t = payments.provider.calls
    assert t[1] - t[0] >= 2.9, "the server-provided 3s delay beats the 1s backoff"


async def test_start_to_close_timeout_is_retried(env, pay):
    payments.provider.script = ["hang", "ok"]
    async with pay:
        t0 = time.monotonic()
        assert await checkout(env, start_to_close_seconds=1.0) == "paid:ch_1:attempt2"
    assert 1.0 <= time.monotonic() - t0 < 6


async def test_retries_exhausted_fails_the_workflow(env, pay):
    payments.provider.script = ["fail_before"] * 10
    async with pay:
        with pytest.raises(WorkflowFailureError) as ei:
            await checkout(env, max_attempts=3)
    assert isinstance(ei.value.cause, ActivityError)
    assert isinstance(ei.value.cause.cause, ApplicationError) and "connection reset" in str(ei.value.cause.cause)
    assert len(payments.provider.calls) == 3


# ============================================================ use case 2: export
@pytest.fixture
async def exp(env):
    export.storage.__init__()
    return Worker(env.client, task_queue=export.TASK_QUEUE, workflows=[export.ExportWorkflow],
                  activities=[export.export_chunks])


async def test_heartbeat_timeout_detects_a_wedged_attempt_and_resumes(env, exp):
    export.storage.hang_at = 5
    async with exp:
        t0 = time.monotonic()
        res = await env.client.execute_workflow(export.ExportWorkflow.run, export.ExportRequest("e1", 10),
                                                id=uid("exp"), task_queue=export.TASK_QUEUE)
    assert res.attempt == 2 and res.resumed_from == 5 and res.chunks == 10
    assert export.storage.written == list(range(10)), "every chunk written exactly once, none redone"
    assert 2.0 <= time.monotonic() - t0 < 10, "1s heartbeat timeout + 1s retry delay, not the 10 minute start-to-close"


async def test_cancellation_reaches_a_heartbeating_activity_and_waits_for_cleanup(env, exp):
    export.storage.chunk_seconds = 0.3
    async with exp:
        h = await env.client.start_workflow(export.ExportWorkflow.run, export.ExportRequest("e2", 40),
                                            id=uid("exp"), task_queue=export.TASK_QUEUE)
        await asyncio.sleep(1.2)
        await h.cancel()
        with pytest.raises(WorkflowFailureError) as ei:
            await h.result()
    assert isinstance(ei.value.cause, CancelledError)
    assert (await h.describe()).status.name == "CANCELED"
    assert "lock released for e2" in export.storage.events        # cleanup ran BEFORE the workflow finished
    assert 0 < len(export.storage.written) < 40                    # and it stopped early


# --- doc claim: "activities that don't heartbeat can't receive cancellation" (test-only code)
SAW = {}


@activity.defn
async def slow_no_heartbeat() -> None:
    SAW["no_hb"] = False
    try:
        for _ in range(40):
            await asyncio.sleep(0.1)
    except asyncio.CancelledError:
        SAW["no_hb"] = True   # would mean cancellation arrived
        raise


@activity.defn
async def slow_with_heartbeat() -> None:
    SAW["hb"] = False
    try:
        for _ in range(40):
            await asyncio.sleep(0.1)
            activity.heartbeat()
    except asyncio.CancelledError:
        SAW["hb"] = True      # cancellation arrives as CancelledError at the next await
        raise


@workflow.defn
class OneActivity:
    @workflow.run
    async def run(self, name: str) -> str:
        await workflow.execute_activity(name, start_to_close_timeout=timedelta(seconds=30),
                                        heartbeat_timeout=timedelta(seconds=1),
                                        cancellation_type=workflow.ActivityCancellationType.TRY_CANCEL)
        return "ok"


async def test_cancellation_is_only_delivered_when_heartbeating(env):
    async with Worker(env.client, task_queue="misc", workflows=[OneActivity],
                      activities=[slow_no_heartbeat, slow_with_heartbeat]):
        for name, key in (("slow_no_heartbeat", "no_hb"), ("slow_with_heartbeat", "hb")):
            h = await env.client.start_workflow(OneActivity.run, name, id=uid("c"), task_queue="misc")
            await asyncio.sleep(0.6)
            await h.cancel()
            with pytest.raises(WorkflowFailureError):
                await h.result()
            await asyncio.sleep(4.0)   # let the activity run to its natural end
    assert SAW == {"no_hb": False, "hb": True}


# ============================================================ use case 3: fan-out
async def run_fanout(env, ids, **kw):
    fanout.api.__init__()
    fanout.api.latency = kw.pop("latency", 0.05)
    fanout.api.throttle_once = set(kw.pop("throttle", []))
    async with fanout.make_worker(env.client, **kw):
        t0 = time.monotonic()
        res = await env.client.execute_workflow(fanout.ProfileSyncWorkflow.run, ids, id=uid("sync"),
                                                task_queue=fanout.TASK_QUEUE)
        return res, time.monotonic() - t0


async def test_fanout_respects_concurrency_and_handles_partial_failure(env):
    ids = [f"u{i}" for i in range(36)] + ["missing1", "missing2"]
    res, _ = await run_fanout(env, ids, throttle=["u3", "u7", "u9"], max_concurrent=5)
    assert len(res.profiles) == 36 and res.missing == ["missing1", "missing2"] and res.failed == []
    assert 1 < fanout.api.max_in_flight <= 5, fanout.api.max_in_flight          # parallel, but never above 5
    assert fanout.api.calls == len(ids) + 3                                    # +3 = one retry each for the throttled ones


async def test_fanout_per_second_limit(env):
    ids = [f"u{i}" for i in range(40)]
    _, unlimited = await run_fanout(env, ids, latency=0.01, max_concurrent=20)
    _, limited = await run_fanout(env, ids, latency=0.01, max_concurrent=20, per_second=20)
    print(f"RATE unlimited={unlimited:.2f}s limited={limited:.2f}s")
    assert limited >= 1.0 and limited > unlimited * 2


# --- doc claim: schedule-to-start timeouts are never retried (test-only code)
@workflow.defn
class QueueDeadline:
    @workflow.run
    async def run(self) -> str:
        await workflow.execute_activity("anything", task_queue="nobody-listens",
                                        schedule_to_start_timeout=timedelta(seconds=1),
                                        start_to_close_timeout=timedelta(seconds=10),
                                        retry_policy=RetryPolicy(maximum_attempts=5, initial_interval=timedelta(milliseconds=100)))
        return "unreachable"


async def test_schedule_to_start_timeout_is_not_retried(env):
    async with Worker(env.client, task_queue="misc2", workflows=[QueueDeadline]):
        t0 = time.monotonic()
        with pytest.raises(WorkflowFailureError) as ei:
            await env.client.execute_workflow(QueueDeadline.run, id=uid("q"), task_queue="misc2")
        assert isinstance(ei.value.cause, ActivityError) and isinstance(ei.value.cause.cause, TimeoutError)
        assert ei.value.cause.cause.type == TimeoutType.SCHEDULE_TO_START
        assert time.monotonic() - t0 < 4, "5 attempts would take >5s: it was NOT retried"


# --- local activities and async completion (test-only code)
@activity.defn
async def quick(x: int) -> int:
    return x * 2


TOKENS: list[bytes] = []


@activity.defn
async def wait_for_callback() -> str:
    TOKENS.append(activity.info().task_token)
    activity.raise_complete_async()


@workflow.defn
class AsyncTimeout:
    @workflow.run
    async def run(self) -> str:
        return await workflow.execute_activity(wait_for_callback, start_to_close_timeout=timedelta(seconds=1),
                                               retry_policy=RetryPolicy(maximum_attempts=1))


@workflow.defn
class LocalAndAsync:
    @workflow.run
    async def run(self, mode: str) -> str:
        if mode == "local":
            return str(await workflow.execute_local_activity(quick, 21, start_to_close_timeout=timedelta(seconds=5)))
        return await workflow.execute_activity(wait_for_callback, start_to_close_timeout=timedelta(seconds=30),
                                               retry_policy=RetryPolicy(maximum_attempts=1))


async def test_local_activity_history_shape_and_async_completion(env):
    async with Worker(env.client, task_queue="misc3", workflows=[LocalAndAsync, AsyncTimeout], activities=[quick, wait_for_callback]):
        # an async-completed activity is still bounded by its timeouts
        with pytest.raises(WorkflowFailureError) as ei:
            await env.client.execute_workflow(AsyncTimeout.run, id=uid("t"), task_queue="misc3")
        assert isinstance(ei.value.cause.cause, TimeoutError) and ei.value.cause.cause.type == TimeoutType.START_TO_CLOSE

        h = await env.client.start_workflow(LocalAndAsync.run, "local", id=uid("l"), task_queue="misc3")
        assert await h.result() == "42"
        types = {e.event_type for e in (await h.fetch_history()).events}
        assert EventType.EVENT_TYPE_MARKER_RECORDED in types
        assert EventType.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED not in types       # never went through a task queue

        TOKENS.clear()
        h = await env.client.start_workflow(LocalAndAsync.run, "async", id=uid("a"), task_queue="misc3")
        for _ in range(100):
            if TOKENS: break
            await asyncio.sleep(0.05)
        await env.client.get_async_activity_handle(task_token=TOKENS[0]).complete("from the webhook")
        assert await h.result() == "from the webhook"

        TOKENS.clear()
        h = await env.client.start_workflow(LocalAndAsync.run, "async", id=uid("a"), task_queue="misc3")
        for _ in range(100):
            if TOKENS: break
            await asyncio.sleep(0.05)
        await env.client.get_async_activity_handle(task_token=TOKENS[0]).fail(ApplicationError("vendor said no", non_retryable=True))
        with pytest.raises(WorkflowFailureError) as ei:
            await h.result()
        assert "vendor said no" in str(ei.value.cause.cause)
