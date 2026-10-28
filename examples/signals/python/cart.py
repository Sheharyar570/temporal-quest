import asyncio
from datetime import timedelta

from temporalio import activity, workflow

TASK_QUEUE = "carts"
ABANDON_AFTER = timedelta(hours=24)
ACTIVITY_OPTS = dict(start_to_close_timeout=timedelta(seconds=30))


@activity.defn
async def create_order(customer_id: str, items: list[str]) -> str:
    # In production: write the order to your database / call the order service.
    return f"order-{customer_id}-{len(items)}"


@activity.defn
async def send_abandoned_cart_email(customer_id: str) -> None:
    # In production: call your email provider.
    activity.logger.info("reminder sent to %s", customer_id)


@workflow.defn
class CartWorkflow:
    def __init__(self) -> None:
        self.items: list[str] = []
        self.checked_out = False
        self.touched = False

    @workflow.signal
    def add_item(self, item: str) -> None:
        self.items.append(item)
        self.touched = True

    @workflow.signal
    def checkout(self) -> None:
        self.checked_out = True

    @workflow.run
    async def run(self, customer_id: str) -> dict:
        while not self.checked_out:
            self.touched = False
            try:
                # Wake on checkout OR on any new item; give up after 24h of silence.
                await workflow.wait_condition(
                    lambda: self.checked_out or self.touched, timeout=ABANDON_AFTER
                )
            except asyncio.TimeoutError:
                await workflow.execute_activity(
                    send_abandoned_cart_email, customer_id, **ACTIVITY_OPTS
                )
                return {"status": "abandoned", "items": self.items}

        order_id = await workflow.execute_activity(
            create_order, args=[customer_id, self.items], **ACTIVITY_OPTS
        )
        return {"status": "ordered", "order_id": order_id, "items": self.items}


# ---- client side: "create the cart if needed, then add an item" in ONE call ----
async def add_to_cart(client, customer_id: str, item: str):
    return await client.start_workflow(
        CartWorkflow.run,
        customer_id,
        id=f"cart-{customer_id}",
        task_queue=TASK_QUEUE,
        start_signal="add_item",
        start_signal_args=[item],
    )
