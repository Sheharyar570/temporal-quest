"""Verification harness: runs each use case against a real (time-skipping) Temporal test server."""
import uuid
from datetime import timedelta

import pytest
from temporalio.client import WorkflowFailureError  # noqa: F401
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import approval
import cart
import entity


@pytest.fixture(scope="module")
async def env():
    async with await WorkflowEnvironment.start_time_skipping() as e:
        yield e


def uid(p):
    return f"{p}-{uuid.uuid4().hex[:6]}"


async def test_cart_signal_with_start_checkout(env):
    async with Worker(env.client, task_queue=cart.TASK_QUEUE, workflows=[cart.CartWorkflow],
                      activities=[cart.create_order, cart.send_abandoned_cart_email]):
        cust = uid("c")
        await cart.add_to_cart(env.client, cust, "book")   # starts the workflow
        await cart.add_to_cart(env.client, cust, "pen")    # signals the SAME running workflow
        h = env.client.get_workflow_handle(f"cart-{cust}")
        await h.signal(cart.CartWorkflow.checkout)
        res = await h.result()
        assert res == {"status": "ordered", "order_id": f"order-{cust}-2", "items": ["book", "pen"]}


async def test_cart_abandoned_after_24h_idle(env):
    async with Worker(env.client, task_queue=cart.TASK_QUEUE, workflows=[cart.CartWorkflow],
                      activities=[cart.create_order, cart.send_abandoned_cart_email]):
        cust = uid("c")
        h = await cart.add_to_cart(env.client, cust, "book")
        res = await h.result()  # time skips 24h
        assert res["status"] == "abandoned" and res["items"] == ["book"]


async def test_cart_activity_resets_idle_timer(env):
    async with Worker(env.client, task_queue=cart.TASK_QUEUE, workflows=[cart.CartWorkflow],
                      activities=[cart.create_order, cart.send_abandoned_cart_email]):
        cust = uid("c")
        await cart.add_to_cart(env.client, cust, "book")
        await env.sleep(timedelta(hours=23))
        await cart.add_to_cart(env.client, cust, "pen")      # resets the 24h clock
        await env.sleep(timedelta(hours=23))
        h = env.client.get_workflow_handle(f"cart-{cust}")
        assert (await h.describe()).status.name == "RUNNING"   # would be abandoned without reset
        await h.signal(cart.CartWorkflow.checkout)
        assert (await h.result())["status"] == "ordered"


async def _approval_worker(env):
    return Worker(env.client, task_queue=approval.TASK_QUEUE, workflows=[approval.ApprovalChainWorkflow],
                  activities=[approval.notify_approver])


async def test_approval_first_level_approves(env):
    async with await _approval_worker(env):
        rid = uid("r")
        req = approval.ApprovalRequest(rid, 500, ["manager", "director"])
        h = await env.client.start_workflow(approval.ApprovalChainWorkflow.run, req, id=rid,
                                            task_queue=approval.TASK_QUEUE)
        await h.signal(approval.ApprovalChainWorkflow.decide, approval.Decision("mallory", True))   # not current
        await h.signal(approval.ApprovalChainWorkflow.decide, approval.Decision("manager", True, "ok"))
        assert await h.result() == "approved"
        st = await h.query(approval.ApprovalChainWorkflow.status)
        assert st["audit"] == ["ignored decision from mallory", "manager approved"]


async def test_approval_escalates_on_timeout_then_director_rejects(env):
    async with await _approval_worker(env):
        rid = uid("r")
        req = approval.ApprovalRequest(rid, 5000, ["manager", "director"], level_timeout_hours=4)
        h = await env.client.start_workflow(approval.ApprovalChainWorkflow.run, req, id=rid,
                                            task_queue=approval.TASK_QUEUE)
        await env.sleep(timedelta(hours=5))   # manager never answers
        assert (await h.query(approval.ApprovalChainWorkflow.status))["waiting_on"] == "director"
        await h.signal(approval.ApprovalChainWorkflow.decide, approval.Decision("manager", True))  # too late
        await h.signal(approval.ApprovalChainWorkflow.decide, approval.Decision("director", False, "no"))
        assert await h.result() == "rejected"
        audit = (await h.query(approval.ApprovalChainWorkflow.status))["audit"]
        assert audit == ["manager timed out, escalating", "ignored decision from manager", "director rejected"]


async def test_approval_expires_when_nobody_answers(env):
    async with await _approval_worker(env):
        rid = uid("r")
        req = approval.ApprovalRequest(rid, 5, ["a", "b"], level_timeout_hours=1)
        assert await env.client.execute_workflow(approval.ApprovalChainWorkflow.run, req, id=rid,
                                                 task_queue=approval.TASK_QUEUE) == "expired"


async def test_entity_dedupe_ordering_and_continue_as_new(env):
    async with Worker(env.client, task_queue=entity.TASK_QUEUE, workflows=[entity.AccountWorkflow],
                      activities=[entity.post_ledger_entry]):
        acct = uid("acct")
        h = await env.client.start_workflow(entity.AccountWorkflow.run, entity.AccountState(acct),
                                            id=acct, task_queue=entity.TASK_QUEUE)
        for i in range(25):
            await h.signal(entity.AccountWorkflow.apply, entity.Event(f"e{i}", 1))
            if i in (3, 4, 12):   # simulate at-least-once delivery from the upstream system
                await h.signal(entity.AccountWorkflow.apply, entity.Event(f"e{i}", 1))
        latest = env.client.get_workflow_handle_for(entity.AccountWorkflow.run, acct)  # no run_id => latest run, typed result
        await latest.signal(entity.AccountWorkflow.close)
        final = await latest.result()
        assert final.balance == 25, final          # duplicates ignored, nothing lost
        assert final.generation >= 3, final        # continued-as-new at least twice
