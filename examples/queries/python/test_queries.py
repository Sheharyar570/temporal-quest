"""Verification harness: runs each use case against a real local Temporal dev server."""
import asyncio
import uuid
from datetime import timedelta

import pytest
from temporalio.client import WorkflowQueryFailedError, WorkflowQueryRejectedError
from temporalio.common import QueryRejectCondition
from temporalio.service import RPCError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import diagnostics
import progress
import tracking


@pytest.fixture(scope="module")
async def env():
    async with await WorkflowEnvironment.start_local() as e:
        yield e


def uid(p):
    return f"{p}-{uuid.uuid4().hex[:6]}"


async def eventually(fn, timeout=10.0):
    """Poll until fn() returns truthy. Signals are async: a query sent right after a signal may not see it yet."""
    end = asyncio.get_event_loop().time() + timeout
    while True:
        v = await fn()
        if v or asyncio.get_event_loop().time() > end:
            return v
        await asyncio.sleep(0.05)


async def event_count(handle):
    return len((await handle.fetch_history()).events)


# ---------------------------------------------------------------- use case 1
async def test_tracking_status_args_errors_closed_and_no_worker(env):
    oid = uid("o")
    items = [tracking.ItemLine("A-1", 2), tracking.ItemLine("B-2", 1)]
    async with Worker(env.client, task_queue=tracking.TASK_QUEUE, workflows=[tracking.OrderTrackingWorkflow]):
        h = await env.client.start_workflow(tracking.OrderTrackingWorkflow.run, args=[oid, items], id=oid,
                                            task_queue=tracking.TASK_QUEUE)
        st = await h.query(tracking.OrderTrackingWorkflow.status)
        assert st.stage == "received" and st.steps_done == []

        # a query with an argument
        assert (await h.query(tracking.OrderTrackingWorkflow.item, tracking.ItemRequest("B-2"))).qty == 1

        # a handler that raises => WorkflowQueryFailedError; the workflow is unaffected
        with pytest.raises(WorkflowQueryFailedError) as ei:
            await h.query(tracking.OrderTrackingWorkflow.item, tracking.ItemRequest("NOPE"))
        assert "no such item" in str(ei.value)
        # an unknown query name is the same error type and lists the known queries
        with pytest.raises(WorkflowQueryFailedError) as ei:
            await h.query("does_not_exist")
        assert "known queries" in str(ei.value)
        assert (await h.describe()).status.name == "RUNNING"

        # queries never write history
        before = await event_count(h)
        for _ in range(20):
            await h.query(tracking.OrderTrackingWorkflow.status)
        assert await event_count(h) == before

        # signal -> state change is asynchronous: poll, don't assume read-your-writes
        await h.signal(tracking.OrderTrackingWorkflow.advance)
        got = await eventually(lambda: _stage_is(h, "packed"))
        assert got
        await h.signal(tracking.OrderTrackingWorkflow.advance)
        await h.signal(tracking.OrderTrackingWorkflow.advance)
        assert await h.result() == "delivered"

        # completed workflows can still be queried (a worker replays history)
        final = await h.query(tracking.OrderTrackingWorkflow.status)
        assert final.stage == "delivered" and final.steps_done == tracking.STAGES

        # ...unless the caller asks to reject non-open workflows
        with pytest.raises(WorkflowQueryRejectedError) as ei:
            await h.query(tracking.OrderTrackingWorkflow.status, reject_condition=QueryRejectCondition.NOT_OPEN)
        assert ei.value.status.name == "COMPLETED"

    # worker gone: even a COMPLETED workflow can't be queried, because replay needs a worker
    with pytest.raises(RPCError) as ei:
        await h.query(tracking.OrderTrackingWorkflow.status, rpc_timeout=timedelta(seconds=30))
    assert ei.value.status.name == "FAILED_PRECONDITION", ei.value.status
    assert "poller" in str(ei.value) or "worker" in str(ei.value), str(ei.value)


async def _stage_is(h, stage):
    return (await h.query(tracking.OrderTrackingWorkflow.status)).stage == stage


# ---------------------------------------------------------------- use case 2
async def test_progress_polling(env):
    async with Worker(env.client, task_queue=progress.TASK_QUEUE, workflows=[progress.ImportWorkflow],
                      activities=[progress.import_chunk]):
        # run A: poll heavily while it runs
        h = await env.client.start_workflow(progress.ImportWorkflow.run, progress.ImportInput(1000), id=uid("imp"),
                                            task_queue=progress.TASK_QUEUE)
        seen = []
        polls = 0
        while True:
            p = await h.query(progress.ImportWorkflow.progress)
            polls += 1
            seen.append(p.done + p.failed)
            if p.finished:
                break
            await asyncio.sleep(0.05)
        assert seen == sorted(seen), "progress never goes backwards"
        assert any(0 < s < 1000 for s in seen), f"expected to observe intermediate progress, saw {seen[:5]}..."
        assert (p.total, p.done, p.failed, p.percent, p.chunks_done) == (1000, 972, 28, 100.0, 10)
        assert len(p.recent_errors) == 5 and p.recent_errors[-1] == "record 999: invalid email"   # bounded
        assert polls > 5
        result = await h.result()
        assert result.finished and result.done == 972
        a_events = await event_count(h)

        # run B: no polling at all
        h2 = await env.client.start_workflow(progress.ImportWorkflow.run, progress.ImportInput(1000), id=uid("imp"),
                                             task_queue=progress.TASK_QUEUE)
        await h2.result()
        assert a_events == await event_count(h2), "polling did not add a single event to history"

        # an in-flight ETA exists while running
        h3 = await env.client.start_workflow(progress.ImportWorkflow.run, progress.ImportInput(1000), id=uid("imp"),
                                             task_queue=progress.TASK_QUEUE)
        eta = await eventually(lambda: _has_eta(h3))
        assert eta
        await h3.result()


async def _has_eta(h):
    p = await h.query(progress.ImportWorkflow.progress)
    return p.eta_seconds is not None and p.eta_seconds > 0 and not p.finished


# ---------------------------------------------------------------- use case 3
async def test_diagnostics_and_builtin_queries(env):
    async with Worker(env.client, task_queue=diagnostics.TASK_QUEUE, workflows=[diagnostics.ShipmentWorkflow],
                      activities=[diagnostics.reserve_stock]):
        oid = uid("ship")
        h = await env.client.start_workflow(diagnostics.ShipmentWorkflow.run, oid, id=oid, task_queue=diagnostics.TASK_QUEUE)
        d = await eventually(lambda: _stuck(h))
        assert d.stage == "awaiting_carrier" and d.waiting_on == "signal: carrier_confirmed"
        assert d.history_length >= 5 and d.continue_as_new_suggested is False

        # built-in queries exist on every workflow
        trace = await h.query("__stack_trace")
        assert isinstance(trace, str) and "run (workflow: ShipmentWorkflow" in trace, trace[:300]   # verbose in Python: names the pending run task
        enhanced = await h.query("__enhanced_stack_trace")
        assert enhanced.sdk.name == "sdk-python"
        meta = await h.query("__temporal_workflow_metadata")
        assert meta.definition.type == "ShipmentWorkflow"
        qnames = {q.name: q.description for q in meta.definition.query_definitions}
        assert qnames["diagnostics"] == "support-friendly snapshot of where this workflow is stuck"
        assert {"__stack_trace", "__enhanced_stack_trace", "__temporal_workflow_metadata"} <= set(qnames)
        assert meta.definition.signal_definitions[0].name == "carrier_confirmed"
        assert meta.current_details == f"order {oid}: waiting for the carrier to confirm pickup"

        await h.signal(diagnostics.ShipmentWorkflow.carrier_confirmed)
        assert await h.result() == "shipped"
        done = await h.query(diagnostics.ShipmentWorkflow.diagnostics)
        assert done.stage == "done" and done.waiting_on is None


async def _stuck(h):
    d = await h.query(diagnostics.ShipmentWorkflow.diagnostics)
    return d if d.stage == "awaiting_carrier" else None
