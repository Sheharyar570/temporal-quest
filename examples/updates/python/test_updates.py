"""Verification harness: runs each use case against a real local Temporal dev server."""
import asyncio
import uuid

import pytest
from temporalio.api.enums.v1 import EventType
from temporalio.client import WorkflowUpdateFailedError, WorkflowUpdateStage
from temporalio.exceptions import ApplicationError
from temporalio.service import RPCError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import address
import payment
import seats


@pytest.fixture(scope="module")
async def env():
    async with await WorkflowEnvironment.start_local() as e:
        yield e


def uid(p):
    return f"{p}-{uuid.uuid4().hex[:6]}"


async def accepted_count(handle):
    hist = await handle.fetch_history()
    return len([e for e in hist.events if e.event_type == EventType.EVENT_TYPE_WORKFLOW_EXECUTION_UPDATE_ACCEPTED])


# ---------------------------------------------------------------- use case 1
async def test_address_change_validated_and_returns_result(env):
    async with Worker(env.client, task_queue=address.TASK_QUEUE, workflows=[address.OrderWorkflow]):
        oid = uid("o")
        h = await env.client.start_workflow(address.OrderWorkflow.run, args=[oid, address.Address("1 Main", "Berlin", "10115", "DE")],
                                            id=oid, task_queue=address.TASK_QUEUE)
        ok = await h.execute_update(address.OrderWorkflow.change_address, address.Address("2 Side", "Munich", "80331", "DE"))
        assert ok.eta_days == 2 and ok.address.city == "Munich"

        for bad, why in [(address.Address("3 Rd", "Paris", "7500", "DE"), "postal code"),
                         (address.Address(" ", "Paris", "75001", "DE"), "street")]:
            with pytest.raises(WorkflowUpdateFailedError) as ei:
                await h.execute_update(address.OrderWorkflow.change_address, bad)
            assert why in str(ei.value.cause)

        assert await accepted_count(h) == 1          # rejected updates left NO trace in history

        await h.signal(address.OrderWorkflow.mark_shipped)
        assert await h.query(address.OrderWorkflow.get_status) == "shipped"
        with pytest.raises(WorkflowUpdateFailedError) as ei:
            await h.execute_update(address.OrderWorkflow.change_address, address.Address("4 New", "Bonn", "53111", "DE"))
        assert "already shipped" in str(ei.value.cause)
        await h.signal(address.OrderWorkflow.mark_delivered)
        assert await h.result() == f"{oid} delivered to Munich"


# ---------------------------------------------------------------- use case 2
class Counter:
    holds: list = []


@pytest.fixture
def counted_hold():
    from temporalio import activity

    @activity.defn(name="place_payment_hold")  # same name, so the workflow calls this stand-in
    async def counted(user: str, seat_list: list[str]) -> str:
        Counter.holds.append((user, tuple(seat_list)))   # count real charges
        if user == "declined":
            raise ApplicationError("payment hold declined", type="HoldDeclined", non_retryable=True)
        await asyncio.sleep(0.2)
        return f"hold-{user}-{'-'.join(seat_list)}"
    return counted


async def test_seat_reservation_race_idempotency_and_close(env, counted_hold):
    Counter.holds.clear()
    async with Worker(env.client, task_queue=seats.TASK_QUEUE, workflows=[seats.EventWorkflow], activities=[counted_hold]):
        eid = uid("ev")
        h = await env.client.start_workflow(seats.EventWorkflow.run, ["A1", "A2", "A3", "B1"], id=eid, task_queue=seats.TASK_QUEUE)

        # two people grab A1 at the same instant: both pass the validator, only one can win
        r = await asyncio.gather(
            h.execute_update(seats.EventWorkflow.reserve, seats.Reservation("ann", ["A1"])),
            h.execute_update(seats.EventWorkflow.reserve, seats.Reservation("bob", ["A1"])),
            return_exceptions=True)
        wins = [x for x in r if isinstance(x, seats.Booking)]
        losses = [x for x in r if isinstance(x, WorkflowUpdateFailedError)]
        assert len(wins) == 1 and len(losses) == 1, r
        assert isinstance(losses[0].cause, ApplicationError) and losses[0].cause.type == "SeatTaken"
        assert len(Counter.holds) == 1               # the loser was NEVER charged

        # same Update ID twice (a client retry): one execution, same answer
        b1 = await h.execute_update(seats.EventWorkflow.reserve, seats.Reservation("cy", ["A2"]), id="req-123")
        b2 = await h.execute_update(seats.EventWorkflow.reserve, seats.Reservation("cy", ["A2"]), id="req-123")
        assert b1 == b2 and len(Counter.holds) == 2

        # a failed payment hold fails the update AND leaves the seat free
        with pytest.raises(WorkflowUpdateFailedError):
            await h.execute_update(seats.EventWorkflow.reserve, seats.Reservation("declined", ["A3"]))
        ok = await h.execute_update(seats.EventWorkflow.reserve, seats.Reservation("dee", ["A3"]))
        assert ok.seats == ["A3"]

        # validator rejects obviously bad requests without touching history
        before = await accepted_count(h)
        for bad in (seats.Reservation("x", []), seats.Reservation("x", ["Z9"]), seats.Reservation("x", ["A1", "A2", "A3", "B1", "C1"])):
            with pytest.raises(WorkflowUpdateFailedError):
                await h.execute_update(seats.EventWorkflow.reserve, bad)
        assert await accepted_count(h) == before

        # start_update returns once ACCEPTED; result() comes later
        uh = await h.start_update(seats.EventWorkflow.reserve, seats.Reservation("eve", ["B1"]), wait_for_stage=WorkflowUpdateStage.ACCEPTED)
        assert (await uh.result()).seats == ["B1"]

        await h.signal(seats.EventWorkflow.close_sales)
        final = await h.result()   # waits for in-flight handlers, then completes
        with pytest.raises(RPCError):   # an update sent to a CLOSED workflow is an RPC error, not a validation error
            await h.execute_update(seats.EventWorkflow.reserve, seats.Reservation("late", ["A1"]))
        assert sorted(final) == ["A1", "A2", "A3", "B1"] and final["A2"] == "cy"


# ---------------------------------------------------------------- use case 3
async def _payment_worker(env):
    return Worker(env.client, task_queue=payment.TASK_QUEUE, workflows=[payment.PaymentWorkflow],
                  activities=[payment.authorize_card, payment.capture_payment, payment.send_receipt])


async def test_update_with_start_early_return(env):
    async with await _payment_worker(env):
        oid = uid("ord")
        result, h = await payment.authorize_and_start(env.client, oid, payment.AuthRequest("tok_ok", 100))
        assert result.approved and result.auth_id == "auth-tok_ok"
        assert (await h.describe()).status.name == "RUNNING"     # caller already has its answer; work continues
        assert await h.result() == "settled"


async def test_update_with_start_same_update_id_is_idempotent(env):
    async with await _payment_worker(env):
        oid = uid("ord")
        r1, _ = await payment.authorize_and_start(env.client, oid, payment.AuthRequest("tok_ok", 100))
        # a client retry with the SAME update id attaches to the existing update, despite the FAIL policy
        r2, _ = await payment.authorize_and_start(env.client, oid, payment.AuthRequest("tok_ok", 100))
        assert r1 == r2


async def test_update_with_start_fail_policy_blocks_a_different_request(env):
    async with await _payment_worker(env):
        oid = uid("ord")
        await payment.authorize_and_start(env.client, oid, payment.AuthRequest("tok_ok", 100))
        with pytest.raises(Exception) as ei:   # NEW update id + FAIL policy + workflow exists => error
            await payment.authorize_and_start(env.client, oid, payment.AuthRequest("tok_ok", 100), request_id="another-request")
        assert "already" in str(ei.value).lower(), repr(ei.value)


async def test_update_with_start_declined(env):
    async with await _payment_worker(env):
        oid = uid("ord")
        with pytest.raises(WorkflowUpdateFailedError) as ei:
            await payment.authorize_and_start(env.client, oid, payment.AuthRequest("tok_declined", 100))
        assert ei.value.cause.type == "CardDeclined"
        h = env.client.get_workflow_handle(f"payment-{oid}")
        assert await h.result() == "declined"
