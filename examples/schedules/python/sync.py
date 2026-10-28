"""Use case 3 (Hard): an incremental sync on a Schedule: last-completion-result as a watermark, pause on failure, backfill."""
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.client import Client, Schedule, ScheduleActionStartWorkflow, SchedulePolicy, ScheduleIntervalSpec, ScheduleSpec, ScheduleState
from temporalio.common import SearchAttributeKey
from temporalio.exceptions import ApplicationError

TASK_QUEUE = "sync"
SCHEDULED_START = SearchAttributeKey.for_datetime("TemporalScheduledStartTime")


class Source:
    """Stand-in for the system we sync from."""

    def __init__(self) -> None:
        self.rows = list(range(1, 6))
        self.up = True
        self.processed: list[int] = []


source = Source()


@activity.defn
async def sync_rows(after: int) -> int:
    if not source.up:
        raise ApplicationError("source is down", non_retryable=True)
    new = [r for r in source.rows if r > after]
    source.processed.extend(new)
    return max(new, default=after)


@dataclass
class SyncResult:
    watermark: int
    previous_run_failed: bool


@workflow.defn
class SyncWorkflow:
    @workflow.run
    async def run(self, mode: str = "sync") -> SyncResult:
        # the Schedule hands each run the result of the last SUCCESSFUL one: a free watermark, no database needed
        last = workflow.get_last_completion_result(type_hint=SyncResult) if workflow.has_last_completion_result() else None
        after = last.watermark if last else 0
        if mode == "hang":  # lets the test cancel or terminate a run
            await workflow.sleep(timedelta(seconds=60))
        wm = await workflow.execute_activity(sync_rows, after, start_to_close_timeout=timedelta(seconds=10))
        return SyncResult(wm, previous_run_failed=workflow.get_last_failure() is not None)


async def create(client: Client, schedule_id: str, *, every: timedelta = timedelta(minutes=1),
                 pause_on_failure: bool = False, paused: bool = False, mode: str = "sync") -> None:
    await client.create_schedule(schedule_id, Schedule(
        action=ScheduleActionStartWorkflow(SyncWorkflow.run, mode, id="sync-" + schedule_id, task_queue=TASK_QUEUE),
        spec=ScheduleSpec(intervals=[ScheduleIntervalSpec(every=every)]),
        policy=SchedulePolicy(pause_on_failure=pause_on_failure),
        state=ScheduleState(paused=paused),
    ))
