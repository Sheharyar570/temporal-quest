from dataclasses import dataclass

from temporalio import workflow

TASK_QUEUE = "tracking"
STAGES = ["packed", "shipped", "delivered"]


@dataclass
class ItemLine:
    sku: str
    qty: int


@dataclass
class ItemRequest:
    sku: str


@dataclass
class OrderStatus:
    order_id: str
    stage: str
    steps_done: list[str]
    updated_at: str  # ISO timestamp taken from workflow.now(), never datetime.now()


@workflow.defn
class OrderTrackingWorkflow:
    @workflow.init
    def __init__(self, order_id: str, items: list[ItemLine]) -> None:
        self.order_id = order_id
        self.items = {i.sku: i for i in items}
        self.stage = "received"
        self.steps_done: list[str] = []
        self.updated_at = workflow.now().isoformat()
        self.advances = 0

    @workflow.signal
    def advance(self) -> None:  # the warehouse / carrier systems push progress in
        self.advances += 1

    @workflow.run
    async def run(self, order_id: str, items: list[ItemLine]) -> str:
        for i, stage in enumerate(STAGES):
            await workflow.wait_condition(lambda i=i: self.advances > i)
            self.stage = stage
            self.steps_done.append(stage)
            self.updated_at = workflow.now().isoformat()
        return self.stage

    # ---- queries: synchronous, read-only, no side effects, no awaits ----
    @workflow.query
    def status(self) -> OrderStatus:
        return OrderStatus(self.order_id, self.stage, list(self.steps_done), self.updated_at)

    @workflow.query
    def item(self, req: ItemRequest) -> ItemLine:  # queries can take arguments
        if req.sku not in self.items:
            # Any exception becomes WorkflowQueryFailedError on the client.
            # It does NOT fail the workflow and does not affect other queries.
            raise ValueError(f"no such item: {req.sku}")
        return self.items[req.sku]
