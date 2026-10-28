from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow

TASK_QUEUE = "shipments"
ACTIVITY_OPTS = dict(start_to_close_timeout=timedelta(seconds=30))


@dataclass
class Diagnostics:
    stage: str
    waiting_on: str | None
    history_length: int
    continue_as_new_suggested: bool
    last_transition_at: str


@activity.defn
async def reserve_stock(order_id: str) -> None:
    activity.logger.info("reserved stock for %s", order_id)


@workflow.defn
class ShipmentWorkflow:
    def __init__(self) -> None:
        self.stage = "starting"
        self.waiting_on: str | None = None
        self.confirmed = False
        self.last_transition_at = workflow.now().isoformat()

    def _enter(self, stage: str, waiting_on: str | None, details: str) -> None:
        self.stage, self.waiting_on = stage, waiting_on
        self.last_transition_at = workflow.now().isoformat()
        workflow.set_current_details(details)  # shown in the Web UI next to the workflow

    @workflow.signal(description="carrier confirms pickup")
    def carrier_confirmed(self) -> None:
        self.confirmed = True

    @workflow.query(description="support-friendly snapshot of where this workflow is stuck")
    def diagnostics(self) -> Diagnostics:
        info = workflow.info()
        return Diagnostics(
            stage=self.stage,
            waiting_on=self.waiting_on,
            history_length=info.get_current_history_length(),
            continue_as_new_suggested=info.is_continue_as_new_suggested(),
            last_transition_at=self.last_transition_at,
        )

    @workflow.run
    async def run(self, order_id: str) -> str:
        self._enter("reserving", "reserve_stock activity", f"reserving stock for {order_id}")
        await workflow.execute_activity(reserve_stock, order_id, **ACTIVITY_OPTS)

        self._enter("awaiting_carrier", "signal: carrier_confirmed", f"order {order_id}: waiting for the carrier to confirm pickup")
        await workflow.wait_condition(lambda: self.confirmed)

        self._enter("done", None, "shipped")
        return "shipped"
