import asyncio
from dataclasses import dataclass, field
from datetime import timedelta

from temporalio import activity, workflow

TASK_QUEUE = "imports"
ACTIVITY_OPTS = dict(start_to_close_timeout=timedelta(seconds=30))
MAX_RECENT_ERRORS = 5  # keep query payloads small and bounded


@dataclass
class ImportInput:
    total_records: int
    chunk_size: int = 100


@dataclass
class ChunkResult:
    ok: int
    failed: int
    errors: list[str] = field(default_factory=list)


@dataclass
class Progress:
    total: int
    done: int
    failed: int
    percent: float
    chunks_done: int
    recent_errors: list[str]
    elapsed_seconds: float
    eta_seconds: float | None
    finished: bool


@activity.defn
async def import_chunk(start: int, size: int) -> ChunkResult:
    # In production: read records [start, start+size) and write them to the target system.
    await asyncio.sleep(0.15)
    bad = [i for i in range(start, start + size) if i % 37 == 0]  # pretend every 37th record is invalid
    return ChunkResult(ok=size - len(bad), failed=len(bad), errors=[f"record {i}: invalid email" for i in bad])


@workflow.defn
class ImportWorkflow:
    @workflow.init
    def __init__(self, inp: ImportInput) -> None:
        self.total = inp.total_records
        self.done = 0
        self.failed = 0
        self.chunks_done = 0
        self.recent_errors: list[str] = []
        self.started_at = workflow.now()
        self.finished = False

    @workflow.query
    def progress(self) -> Progress:
        # O(1): everything is kept in counters, nothing is computed over big collections.
        elapsed = (workflow.now() - self.started_at).total_seconds()
        processed = self.done + self.failed
        eta = None if self.finished or processed == 0 else elapsed / processed * (self.total - processed)
        return Progress(
            total=self.total, done=self.done, failed=self.failed,
            percent=round(100 * processed / self.total, 1) if self.total else 100.0,
            chunks_done=self.chunks_done, recent_errors=list(self.recent_errors),
            elapsed_seconds=elapsed, eta_seconds=eta, finished=self.finished,
        )

    @workflow.run
    async def run(self, inp: ImportInput) -> Progress:
        for start in range(0, inp.total_records, inp.chunk_size):
            size = min(inp.chunk_size, inp.total_records - start)
            r = await workflow.execute_activity(import_chunk, args=[start, size], **ACTIVITY_OPTS)
            self.done += r.ok
            self.failed += r.failed
            self.chunks_done += 1
            self.recent_errors = (self.recent_errors + r.errors)[-MAX_RECENT_ERRORS:]
        self.finished = True
        return self.progress()
