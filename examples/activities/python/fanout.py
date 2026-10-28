import asyncio
from dataclasses import dataclass, field
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.worker import Worker

TASK_QUEUE = "profiles"


class NotFound(Exception):
    pass


class TooManyRequests(Exception):
    def __init__(self, retry_after: float) -> None:
        self.retry_after = retry_after


class FakeApi:
    """Stand-in for a third-party API that tolerates only a few concurrent callers."""

    def __init__(self) -> None:
        self.in_flight = 0
        self.max_in_flight = 0
        self.calls = 0
        self.throttle_once: set[str] = set()
        self.latency = 0.05

    async def get_profile(self, user_id: str) -> str:
        self.calls += 1
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.latency)
            if user_id.startswith("missing"):
                raise NotFound(user_id)
            if user_id in self.throttle_once:
                self.throttle_once.discard(user_id)
                raise TooManyRequests(3)  # the API says: come back in 3 seconds
            return f"user {user_id}"
        finally:
            self.in_flight -= 1


api = FakeApi()


@dataclass
class SyncResult:
    profiles: dict[str, str] = field(default_factory=dict)
    missing: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)


@activity.defn
async def fetch_profile(user_id: str) -> str:
    try:
        return await api.get_profile(user_id)
    except NotFound:
        raise ApplicationError(f"{user_id} does not exist", type="NotFound", non_retryable=True)
    except TooManyRequests as e:
        raise ApplicationError("429", type="RateLimited", next_retry_delay=timedelta(seconds=e.retry_after))


@workflow.defn
class ProfileSyncWorkflow:
    @workflow.run
    async def run(self, user_ids: list[str]) -> SyncResult:
        results = await asyncio.gather(
            *[
                workflow.execute_activity(
                    fetch_profile,
                    uid,
                    start_to_close_timeout=timedelta(seconds=10),
                    retry_policy=RetryPolicy(initial_interval=timedelta(seconds=1), maximum_attempts=5),
                )
                for uid in user_ids
            ],
            return_exceptions=True,  # one bad user must not lose the other results
        )
        out = SyncResult()
        for uid, r in zip(user_ids, results):
            if isinstance(r, ActivityError):
                if isinstance(r.cause, ApplicationError) and r.cause.type == "NotFound":
                    out.missing.append(uid)
                else:
                    out.failed.append(uid)
            elif isinstance(r, BaseException):
                raise r
            else:
                out.profiles[uid] = r
        return out


def make_worker(client: Client, max_concurrent: int = 5, per_second: float | None = None) -> Worker:
    """The API only tolerates `max_concurrent` callers (and `per_second` calls); enforce that at the worker."""
    return Worker(
        client,
        task_queue=TASK_QUEUE,
        workflows=[ProfileSyncWorkflow],
        activities=[fetch_profile],
        max_concurrent_activities=max_concurrent,  # at most N activities run at once on this worker
        max_activities_per_second=per_second,  # and at most N start per second
    )
