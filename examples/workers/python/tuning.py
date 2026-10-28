"""Use case 3 (Hard): reading a worker's own metrics to size it: task slots, Schedule-To-Start latency and the sticky cache."""
import asyncio
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.runtime import PrometheusConfig, Runtime, TelemetryConfig
from temporalio.worker import Worker


def metrics_runtime(port: int) -> Runtime:
    """Expose the SDK's metrics (the same names the docs list) at http://127.0.0.1:<port>/metrics.
    Create it BEFORE the client/worker and pass it to the client."""
    return Runtime(telemetry=TelemetryConfig(metrics=PrometheusConfig(bind_address=f"127.0.0.1:{port}")))


def tuned_worker(client: Client, queue: str, *, max_concurrent_activities: int = 100, max_cached_workflows: int = 1000) -> Worker:
    return Worker(
        client, task_queue=queue, workflows=[WorkWorkflow, WaitWorkflow], activities=[work],
        max_concurrent_activities=max_concurrent_activities,  # activity slots (default 100 in Python)
        max_cached_workflows=max_cached_workflows,  # sticky cache (default 1000 in Python)
    )


RUNNING = {"now": 0, "peak": 0}


@activity.defn
async def work(seconds: float) -> None:
    RUNNING["now"] += 1
    RUNNING["peak"] = max(RUNNING["peak"], RUNNING["now"])
    try:
        await asyncio.sleep(seconds)
    finally:
        RUNNING["now"] -= 1


@workflow.defn
class WorkWorkflow:
    @workflow.run
    async def run(self, seconds: float) -> None:
        await workflow.execute_activity(work, seconds, start_to_close_timeout=timedelta(seconds=30))


@workflow.defn
class WaitWorkflow:
    """Waits for two pokes: each poke is a workflow task that needs the workflow's state (from cache, or by replay)."""

    def __init__(self) -> None:
        self.pokes = 0

    @workflow.signal
    def poke(self) -> None:
        self.pokes += 1

    @workflow.run
    async def run(self) -> int:
        await workflow.wait_condition(lambda: self.pokes >= 2)
        return self.pokes
