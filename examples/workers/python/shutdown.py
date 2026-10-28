"""Use case 2 (Hard): deploying and crashing workers without losing work."""
import asyncio
import os
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

TASK_QUEUE = "render"


@activity.defn
async def render(job: str, work_dir: str, seconds: float) -> str:
    info = activity.info()
    # one marker file per attempt, so the test can see which attempt ran where
    open(os.path.join(work_dir, f"{job}.attempt{info.attempt}.started"), "w").write(str(os.getpid()))
    try:
        for _ in range(int(seconds / 0.2)):
            await asyncio.sleep(0.2)
            activity.heartbeat()  # lets the service notice a dead worker in seconds instead of minutes
    except asyncio.CancelledError:
        # worker shutdown (grace period over) or workflow cancel. Say which, then re-raise.
        open(os.path.join(work_dir, f"{job}.attempt{info.attempt}.cancelled"), "w").write(
            "worker-shutdown" if activity.is_worker_shutdown() else "other")
        raise
    return f"{job}:attempt{info.attempt}"


@workflow.defn
class RenderWorkflow:
    @workflow.run
    async def run(self, job: str, work_dir: str, seconds: float) -> str:
        return await workflow.execute_activity(
            render, args=[job, work_dir, seconds],
            start_to_close_timeout=timedelta(seconds=60),
            heartbeat_timeout=timedelta(seconds=2),
            retry_policy=RetryPolicy(initial_interval=timedelta(seconds=1)))
