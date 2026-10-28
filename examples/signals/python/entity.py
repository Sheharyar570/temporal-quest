from dataclasses import dataclass, field, replace
from datetime import timedelta

from temporalio import activity, workflow

TASK_QUEUE = "accounts"
ACTIVITY_OPTS = dict(start_to_close_timeout=timedelta(seconds=30))
MAX_EVENTS_PER_RUN = 10   # tiny on purpose so the demo continues-as-new quickly
MAX_SEEN = 1000           # how many event IDs we remember for de-duplication


@dataclass
class Event:
    event_id: str  # unique per business event, supplied by the sender
    amount: int


@dataclass
class AccountState:
    account_id: str
    balance: int = 0
    generation: int = 1                      # which run of this entity we are in
    processed: int = 0                       # events handled in the CURRENT run
    seen: list[str] = field(default_factory=list)
    pending: list[Event] = field(default_factory=list)
    closing: bool = False                    # carried too, or a close signal could be lost


@activity.defn
async def post_ledger_entry(account_id: str, event_id: str, amount: int) -> None:
    # In production: INSERT ... ON CONFLICT (event_id) DO NOTHING  (idempotent write).
    activity.logger.info("ledger %s %s %+d", account_id, event_id, amount)


@workflow.defn
class AccountWorkflow:
    @workflow.init
    def __init__(self, state: AccountState) -> None:
        self.state = state
        self.seen: dict[str, None] = dict.fromkeys(state.seen)  # insertion-ordered set

    @workflow.signal
    def apply(self, event: Event) -> None:
        if event.event_id in self.seen:
            return  # duplicate delivery: already queued or processed
        self.seen[event.event_id] = None
        self.state.pending.append(event)

    @workflow.signal
    def close(self) -> None:
        self.state.closing = True

    @workflow.query
    def balance(self) -> int:
        return self.state.balance

    def _time_to_continue_as_new(self) -> bool:
        return (
            self.state.processed >= MAX_EVENTS_PER_RUN
            or workflow.info().is_continue_as_new_suggested()
        )

    @workflow.run
    async def run(self, state: AccountState) -> AccountState:
        s = self.state
        while True:
            await workflow.wait_condition(lambda: bool(s.pending) or s.closing)

            # Strict FIFO, one event at a time. Check the limit INSIDE the loop,
            # otherwise a big backlog is drained into a single ever-growing history.
            while s.pending and not self._time_to_continue_as_new():
                e = s.pending.pop(0)
                await workflow.execute_activity(
                    post_ledger_entry, args=[s.account_id, e.event_id, e.amount], **ACTIVITY_OPTS
                )
                s.balance += e.amount
                s.processed += 1

            if s.closing and not s.pending:
                return s

            if self._time_to_continue_as_new():
                await workflow.wait_condition(workflow.all_handlers_finished)
                workflow.continue_as_new(
                    replace(
                        s,
                        generation=s.generation + 1,
                        processed=0,
                        seen=list(self.seen)[-MAX_SEEN:],
                    )
                )
