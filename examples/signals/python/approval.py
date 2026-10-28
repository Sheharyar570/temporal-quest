import asyncio
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow

TASK_QUEUE = "approvals"
ACTIVITY_OPTS = dict(start_to_close_timeout=timedelta(seconds=30))


@dataclass
class ApprovalRequest:
    request_id: str
    amount: int
    approvers: list[str]  # escalation chain, lowest level first
    level_timeout_hours: int = 4


@dataclass
class Decision:
    approver: str
    approved: bool
    comment: str = ""


@activity.defn
async def notify_approver(approver: str, request_id: str) -> None:
    # In production: Slack / email / push notification with an approve/reject link.
    activity.logger.info("asked %s to review %s", approver, request_id)


@workflow.defn
class ApprovalChainWorkflow:
    def __init__(self) -> None:
        self.current: str | None = None
        self.decision: Decision | None = None
        self.audit: list[str] = []

    @workflow.signal
    def decide(self, d: Decision) -> None:
        # Handlers only RECORD. Authorisation is checked here, decisions are made in run().
        if d.approver != self.current or self.decision is not None:
            self.audit.append(f"ignored decision from {d.approver}")
            return
        self.decision = d
        self.audit.append(f"{d.approver} {'approved' if d.approved else 'rejected'}")

    @workflow.query
    def status(self) -> dict:
        return {"waiting_on": self.current, "audit": self.audit}

    @workflow.run
    async def run(self, req: ApprovalRequest) -> str:
        for approver in req.approvers:
            self.current, self.decision = approver, None
            await workflow.execute_activity(
                notify_approver, args=[approver, req.request_id], **ACTIVITY_OPTS
            )
            try:
                await workflow.wait_condition(
                    lambda: self.decision is not None,
                    timeout=timedelta(hours=req.level_timeout_hours),
                )
            except asyncio.TimeoutError:
                self.audit.append(f"{approver} timed out, escalating")
                continue  # next approver in the chain
            return "approved" if self.decision.approved else "rejected"

        self.current = None
        return "expired"
