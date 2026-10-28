import asyncio
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.client import WithStartWorkflowOperation
from temporalio.common import WorkflowIDConflictPolicy
from temporalio.exceptions import ApplicationError

TASK_QUEUE = "payments"
ACTIVITY_OPTS = dict(start_to_close_timeout=timedelta(seconds=30))
SETTLEMENT_DELAY = timedelta(seconds=1)  # in production: hours or days


@dataclass
class AuthRequest:
    card_token: str
    amount: int


@dataclass
class AuthResult:
    approved: bool
    auth_id: str = ""
    reason: str = ""


@activity.defn
async def authorize_card(req: AuthRequest) -> AuthResult:
    # In production: call the payment provider.
    if req.card_token == "tok_declined":
        return AuthResult(approved=False, reason="insufficient funds")
    return AuthResult(approved=True, auth_id="auth-" + req.card_token)


@activity.defn
async def capture_payment(auth_id: str) -> None:
    activity.logger.info("captured %s", auth_id)


@activity.defn
async def send_receipt(order_id: str) -> None:
    activity.logger.info("receipt for %s", order_id)


@workflow.defn
class PaymentWorkflow:
    def __init__(self) -> None:
        self.auth: AuthResult | None = None
        self.lock = asyncio.Lock()

    @workflow.update
    async def authorize(self, req: AuthRequest) -> AuthResult:
        async with self.lock:
            if self.auth is not None:  # already decided: repeat calls get the same answer
                return self.auth
            result = await workflow.execute_activity(authorize_card, req, **ACTIVITY_OPTS)
            self.auth = result
        if not result.approved:
            # Raising ApplicationError FAILS THE UPDATE (the caller sees it); the workflow lives on.
            raise ApplicationError(result.reason, type="CardDeclined", non_retryable=True)
        return result

    @workflow.run
    async def run(self, order_id: str) -> str:
        await workflow.wait_condition(lambda: self.auth is not None)
        await workflow.wait_condition(workflow.all_handlers_finished)
        if not self.auth.approved:
            return "declined"
        # The caller already has its answer; the slow part continues in the background.
        await workflow.execute_activity(capture_payment, self.auth.auth_id, **ACTIVITY_OPTS)
        await workflow.sleep(SETTLEMENT_DELAY)
        await workflow.execute_activity(send_receipt, order_id, **ACTIVITY_OPTS)
        return "settled"


# ---- client side: start the workflow AND get the authorisation answer in one call ----
async def authorize_and_start(client: Client, order_id: str, req: AuthRequest, request_id: str | None = None):
    start_op = WithStartWorkflowOperation(
        PaymentWorkflow.run,
        order_id,
        id=f"payment-{order_id}",
        task_queue=TASK_QUEUE,
        id_conflict_policy=WorkflowIDConflictPolicy.FAIL,  # a second payment for this order is an error
    )
    result = await client.execute_update_with_start_workflow(
        PaymentWorkflow.authorize, req, start_workflow_operation=start_op,
        id=request_id or f"auth-{order_id}",  # the Update ID doubles as an idempotency key
    )
    return result, await start_op.workflow_handle()
