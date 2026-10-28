import asyncio
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

TASK_QUEUE = "exports"


class FakeStorage:
    """Stand-in for object storage plus a lock service."""

    def __init__(self) -> None:
        self.written: list[int] = []
        self.events: list[str] = []
        self.hang_at: int | None = None  # make the first write of this chunk wedge
        self.chunk_seconds = 0.0

    async def write_chunk(self, export_id: str, i: int) -> None:
        if self.hang_at == i:
            self.hang_at = None  # wedge only once
            self.events.append(f"hang at {i}")
            await asyncio.sleep(30)  # a stuck call: no progress, no heartbeats
        await asyncio.sleep(self.chunk_seconds)
        self.written.append(i)

    async def release_lock(self, export_id: str) -> None:
        self.events.append(f"lock released for {export_id}")


storage = FakeStorage()


@dataclass
class ExportRequest:
    export_id: str
    total_chunks: int


@dataclass
class ExportResult:
    resumed_from: int  # first chunk THIS attempt processed
    attempt: int
    chunks: int


@activity.defn
async def export_chunks(req: ExportRequest) -> ExportResult:
    info = activity.info()
    # Heartbeat details survive failed attempts: resume right after the last chunk reported as done.
    start = int(info.heartbeat_details[0]) + 1 if info.heartbeat_details else 0
    try:
        for i in range(start, req.total_chunks):
            await storage.write_chunk(req.export_id, i)  # must be idempotent: a chunk can be written twice
            activity.heartbeat(i)  # "chunk i is done": proves liveness, saves progress, and receives cancellation
    except asyncio.CancelledError:
        await storage.release_lock(req.export_id)  # clean up, then let the cancellation continue
        raise
    return ExportResult(resumed_from=start, attempt=info.attempt, chunks=req.total_chunks)


@workflow.defn
class ExportWorkflow:
    @workflow.run
    async def run(self, req: ExportRequest) -> ExportResult:
        return await workflow.execute_activity(
            export_chunks,
            req,
            start_to_close_timeout=timedelta(minutes=10),
            heartbeat_timeout=timedelta(seconds=1),  # a silent worker is detected in 1s, not 10 minutes
            retry_policy=RetryPolicy(initial_interval=timedelta(seconds=1), maximum_attempts=5),
            # On cancel, wait until the activity has finished cleaning up before the workflow moves on.
            cancellation_type=workflow.ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
        )
