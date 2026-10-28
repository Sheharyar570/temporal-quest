"""Use case 2 (Hard): what each Overlap Policy does when a run is still going as the next one is due."""
from datetime import timedelta

from temporalio import workflow
from temporalio.client import Client, Schedule, ScheduleActionStartWorkflow, SchedulePolicy, ScheduleOverlapPolicy, ScheduleSpec

TASK_QUEUE = "overlap"


@workflow.defn
class SlowJob:
    @workflow.run
    async def run(self, seconds: float) -> str:
        await workflow.sleep(timedelta(seconds=seconds))  # cancellable: a cancel request surfaces here
        return "done"


async def create(client: Client, schedule_id: str, policy: ScheduleOverlapPolicy, seconds: float = 4) -> None:
    await client.create_schedule(schedule_id, Schedule(
        action=ScheduleActionStartWorkflow(SlowJob.run, seconds, id="job-" + schedule_id, task_queue=TASK_QUEUE),
        spec=ScheduleSpec(),  # no times: this demo fires the Schedule by hand with trigger() so the timing is exact
        policy=SchedulePolicy(overlap=policy),
    ))
