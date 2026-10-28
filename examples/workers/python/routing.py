"""Use case 1 (Medium): routing work with Task Queues: a GPU queue for capability, and a per-host queue for file affinity."""
from dataclasses import dataclass
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.exceptions import ActivityError
from temporalio.worker import Worker

SHARED_QUEUE = "media"  # every host polls this one, but only for get_host_queue
GPU_QUEUE = "media-gpu"  # only GPU machines poll this one


class Host:
    """One machine. Its files live in `disk`: only this host can see them."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.queue = f"media-host-{name}"  # unique to this host
        self.disk: dict[str, str] = {}
        self.log: list[tuple[str, str]] = []  # (step, host)

    @activity.defn(name="get_host_queue")
    async def get_host_queue(self) -> str:
        return self.queue  # whichever host picks this up tells the workflow how to reach it

    @activity.defn
    async def download(self, name: str) -> str:
        path = f"/tmp/{name}"
        self.disk[path] = "raw"
        self.log.append(("download", self.name))
        return path

    @activity.defn
    async def process(self, path: str) -> str:
        assert self.disk[path] == "raw", f"{path} is not on {self.name}"  # fails on any other host
        self.disk[path] = "processed"
        self.log.append(("process", self.name))
        return path

    @activity.defn
    async def upload(self, path: str) -> str:
        assert self.disk[path] == "processed", f"{path} is not on {self.name}"
        self.log.append(("upload", self.name))
        return self.name


@activity.defn
async def render_on_gpu(name: str) -> str:
    return f"rendered:{name}"


def host_workers(client: Client, host: Host, *, reachable: bool = True) -> list[Worker]:
    """A host runs two Worker entities: the shared queue (just the lookup) and its own queue (the real work).
    reachable=False leaves out the second one, to simulate a host that died after answering the lookup."""
    ws = [Worker(client, task_queue=SHARED_QUEUE, activities=[host.get_host_queue])]
    if reachable:
        ws.append(Worker(client, task_queue=host.queue, activities=[host.download, host.process, host.upload]))
    return ws


@dataclass
class MediaResult:
    host: str
    rendered: str


@workflow.defn
class MediaWorkflow:
    @workflow.run
    async def run(self, name: str) -> MediaResult:
        for _ in range(4):  # a dead host must not strand the job: pick another one
            queue = await workflow.execute_activity(
                "get_host_queue", task_queue=SHARED_QUEUE, start_to_close_timeout=timedelta(seconds=10), result_type=str)
            # affinity: the next three steps must run on the machine that holds the file
            host_opts = dict(task_queue=queue, start_to_close_timeout=timedelta(seconds=10),
                             schedule_to_start_timeout=timedelta(seconds=2))  # fail fast if that host is gone
            try:
                path = await workflow.execute_activity("download", name, result_type=str, **host_opts)
                path = await workflow.execute_activity("process", path, result_type=str, **host_opts)
                host = await workflow.execute_activity("upload", path, result_type=str, **host_opts)
                break
            except ActivityError:
                continue
        else:
            raise RuntimeError("no reachable host")
        # capability routing: only the GPU queue's workers know how to do this
        rendered = await workflow.execute_activity(
            render_on_gpu, name, task_queue=GPU_QUEUE, start_to_close_timeout=timedelta(seconds=10))
        return MediaResult(host, rendered)
