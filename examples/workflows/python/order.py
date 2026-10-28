"""Use case 2 (Hard): changing a workflow that already has running executions, using patching.

Four deploys of the SAME workflow type, shown as four classes so you can compare them.
In a real repo there is only ever one `OrderWorkflow`; each step replaces the previous one.
"""
from datetime import timedelta

from temporalio import activity, workflow

TASK_QUEUE = "orders"
CALLS: list[str] = []


@activity.defn
async def charge(order: str) -> None:
    CALLS.append("charge")


@activity.defn
async def fraud_check(order: str) -> None:
    CALLS.append("fraud_check")


@activity.defn
async def ship(order: str) -> None:
    CALLS.append("ship")


T = dict(start_to_close_timeout=timedelta(seconds=10))


# ---- v1: what is deployed today. Executions started now will still be open when v2 ships.
@workflow.defn(name="OrderWorkflow")
class OrderV1:
    def __init__(self) -> None:
        self.packed = False

    @workflow.signal
    def packed_signal(self) -> None:
        self.packed = True

    @workflow.run
    async def run(self, order: str) -> str:
        await workflow.execute_activity(charge, order, **T)
        await workflow.wait_condition(lambda: self.packed)  # open executions wait here for days
        await workflow.execute_activity(ship, order, **T)
        return "shipped"


# ---- v2 (step 1): add a fraud check, guarded by a patch. Old executions keep the old path.
@workflow.defn(name="OrderWorkflow")
class OrderV2Patched:
    def __init__(self) -> None:
        self.packed = False

    @workflow.signal
    def packed_signal(self) -> None:
        self.packed = True

    @workflow.run
    async def run(self, order: str) -> str:
        if workflow.patched("fraud-check"):
            await workflow.execute_activity(fraud_check, order, **T)
        await workflow.execute_activity(charge, order, **T)
        await workflow.wait_condition(lambda: self.packed)
        await workflow.execute_activity(ship, order, **T)
        return "shipped"


# ---- v3 (step 2): every execution that started before v2 has finished. Keep the marker call, drop the old branch.
@workflow.defn(name="OrderWorkflow")
class OrderV3Deprecated:
    def __init__(self) -> None:
        self.packed = False

    @workflow.signal
    def packed_signal(self) -> None:
        self.packed = True

    @workflow.run
    async def run(self, order: str) -> str:
        workflow.deprecate_patch("fraud-check")
        await workflow.execute_activity(fraud_check, order, **T)
        await workflow.execute_activity(charge, order, **T)
        await workflow.wait_condition(lambda: self.packed)
        await workflow.execute_activity(ship, order, **T)
        return "shipped"


# ---- the mistake: the same change with no patch
@workflow.defn(name="OrderWorkflow")
class OrderV2Naive:
    def __init__(self) -> None:
        self.packed = False

    @workflow.signal
    def packed_signal(self) -> None:
        self.packed = True

    @workflow.run
    async def run(self, order: str) -> str:
        await workflow.execute_activity(fraud_check, order, **T)
        await workflow.execute_activity(charge, order, **T)
        await workflow.wait_condition(lambda: self.packed)
        await workflow.execute_activity(ship, order, **T)
        return "shipped"


# ---- a subtler mistake: appending a step right where old executions are waiting
@workflow.defn(name="OrderWorkflow")
class OrderV2Appended:
    def __init__(self) -> None:
        self.packed = False

    @workflow.signal
    def packed_signal(self) -> None:
        self.packed = True

    @workflow.run
    async def run(self, order: str) -> str:
        await workflow.execute_activity(charge, order, **T)
        await workflow.execute_activity(fraud_check, order, **T)
        await workflow.wait_condition(lambda: self.packed)
        await workflow.execute_activity(ship, order, **T)
        return "shipped"
