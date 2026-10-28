import asyncio
import time
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError

TASK_QUEUE = "payments"


class CardDeclined(Exception):
    pass


class RateLimited(Exception):
    def __init__(self, retry_after: float) -> None:
        self.retry_after = retry_after


class FakeProvider:
    """Stand-in for a payment API. Idempotent by key, like Stripe's Idempotency-Key header."""

    def __init__(self) -> None:
        self.script: list[str] = []  # one scripted behaviour per call, then "ok"
        self.charges: dict[str, str] = {}  # idempotency key -> charge id
        self.calls: list[float] = []

    async def charge(self, key: str, amount: int, card_token: str) -> str:
        self.calls.append(time.monotonic())
        step = self.script.pop(0) if self.script else "ok"
        if step == "decline":
            raise CardDeclined("card declined")
        if step.startswith("rate_limit:"):
            raise RateLimited(float(step.split(":")[1]))
        if step == "fail_before":
            raise ConnectionError("connection reset")
        if step == "hang":
            await asyncio.sleep(30)
        charge_id = self.charges.setdefault(key, f"ch_{len(self.charges) + 1}")  # same key => same charge
        if step == "fail_after":
            raise ConnectionError("response lost, but the charge went through")
        return charge_id


provider = FakeProvider()


@dataclass
class CheckoutRequest:
    order_id: str
    amount: int
    card_token: str
    max_attempts: int = 6
    start_to_close_seconds: float = 2.0


@dataclass
class ChargeResult:
    charge_id: str
    attempt: int


@activity.defn
async def charge_card(req: CheckoutRequest) -> ChargeResult:
    info = activity.info()
    # Stable across retries of THIS activity, different for every other activity.
    key = f"{info.workflow_run_id}-{info.activity_id}"
    try:
        charge_id = await provider.charge(key, req.amount, req.card_token)
    except CardDeclined as e:
        # Retrying can never help: fail immediately.
        raise ApplicationError(str(e), type="CardDeclined", non_retryable=True)
    except RateLimited as e:
        # The server told us when to come back: override the backoff for this one retry.
        raise ApplicationError("rate limited", type="RateLimited", next_retry_delay=timedelta(seconds=e.retry_after))
    # Anything else (ConnectionError, ...) escapes as-is and is retried with backoff.
    return ChargeResult(charge_id, info.attempt)


@workflow.defn
class CheckoutWorkflow:
    @workflow.run
    async def run(self, req: CheckoutRequest) -> str:
        try:
            result = await workflow.execute_activity(
                charge_card,
                req,
                start_to_close_timeout=timedelta(seconds=req.start_to_close_seconds),  # per ATTEMPT
                retry_policy=RetryPolicy(
                    initial_interval=timedelta(seconds=1),  # waits 1s, 2s, 4s, ... between attempts
                    backoff_coefficient=2.0,
                    maximum_interval=timedelta(seconds=30),  # ...but never more than 30s
                    maximum_attempts=req.max_attempts,
                ),
            )
        except ActivityError as e:
            if isinstance(e.cause, ApplicationError) and e.cause.type == "CardDeclined":
                return "declined"  # a business outcome, not a crash
            raise  # retries exhausted or unexpected: let the workflow fail loudly
        return f"paid:{result.charge_id}:attempt{result.attempt}"
