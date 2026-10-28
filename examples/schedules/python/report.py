"""Use case 1 (Medium): a daily report on a Schedule: calendar + time zone, trigger, pause, update, limited runs, delete."""
from datetime import timedelta

from temporalio import workflow
from temporalio.client import (
    Client, Schedule, ScheduleActionStartWorkflow, ScheduleCalendarSpec, SchedulePolicy, ScheduleRange,
    ScheduleSpec, ScheduleState,
)
from temporalio.common import SearchAttributeKey

TASK_QUEUE = "reports"
SCHEDULED_START = SearchAttributeKey.for_datetime("TemporalScheduledStartTime")  # set by the Schedule on every run it starts


@workflow.defn
class ReportWorkflow:
    @workflow.run
    async def run(self, region: str, seconds_of_work: float = 0) -> str:
        scheduled = workflow.info().typed_search_attributes.get(SCHEDULED_START)
        await workflow.sleep(timedelta(seconds=seconds_of_work))
        return f"{region} report for {scheduled.isoformat() if scheduled else 'manual start'}"


def daily_schedule(schedule_id: str, region: str, *, seconds_of_work: float = 0) -> Schedule:
    return Schedule(
        action=ScheduleActionStartWorkflow(
            ReportWorkflow.run, args=[region, seconds_of_work],
            # the Schedule appends the action's timestamp (to the second) to this, so make the base unique PER SCHEDULE
            id=f"report-{schedule_id}",
            task_queue=TASK_QUEUE,
        ),
        spec=ScheduleSpec(
            # every day at 09:00 New York time, DST included. minute and second default to 0.
            calendars=[ScheduleCalendarSpec(hour=[ScheduleRange(9)])],
            time_zone_name="America/New_York",
        ),
        policy=SchedulePolicy(),
        state=ScheduleState(note="daily report"),
    )


async def create(client: Client, schedule_id: str, region: str = "emea") -> None:
    await client.create_schedule(schedule_id, daily_schedule(schedule_id, region))
