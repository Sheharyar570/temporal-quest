"""Use case 1 (Medium): a free-trial lifecycle built from durable timers, and why workflow code must be deterministic."""
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow

TASK_QUEUE = "trials"
SENT: list[tuple[str, str]] = []  # (key, kind): stand-in for an email provider


@activity.defn
async def send_email(user: str, kind: str, key: str) -> None:
    if (key, kind) not in SENT:  # the key makes a retried send harmless
        SENT.append((key, kind))


@dataclass
class TrialRequest:
    user: str
    reminder_after_days: int = 11
    length_days: int = 14


@workflow.defn
class TrialWorkflow:
    def __init__(self) -> None:
        self.converted = False
        self.started_at = None

    @workflow.signal
    def convert(self) -> None:
        self.converted = True

    @workflow.query
    def ends_at(self) -> str:
        return (self.started_at + self._length).isoformat() if self.started_at else ""

    @workflow.run
    async def run(self, req: TrialRequest) -> str:
        self._length = timedelta(days=req.length_days)
        self.started_at = workflow.now()  # replay-safe clock: the time of the workflow task, recorded in history
        key = str(workflow.uuid4())  # replay-safe UUID: identical on every replay
        send = lambda kind: workflow.execute_activity(
            send_email, args=[req.user, kind, key], start_to_close_timeout=timedelta(seconds=10))

        await send("welcome")
        # sleeping costs nothing while the timer is pending; a worker restart cannot lose it
        try:
            await workflow.wait_condition(lambda: self.converted, timeout=timedelta(days=req.reminder_after_days))
        except TimeoutError:
            await send("reminder")
            try:
                await workflow.wait_condition(lambda: self.converted, timeout=timedelta(days=req.length_days - req.reminder_after_days))
            except TimeoutError:
                await send("expired")
                return "expired"
        await send("thanks")
        return "converted"
