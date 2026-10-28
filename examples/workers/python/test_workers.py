"""Verification harness: runs each use case against a real local Temporal dev server."""
import asyncio
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from datetime import timedelta

import pytest
from temporalio import workflow
from temporalio.client import Client, WorkflowFailureError
from temporalio.runtime import Runtime, TelemetryConfig
from temporalio.exceptions import ActivityError, ApplicationError, TimeoutError, TimeoutType
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

import routing
import shutdown
import tuning


@pytest.fixture(scope="module")
async def env():
    async with await WorkflowEnvironment.start_local() as e:
        yield e


def uid(p):
    return f"{p}-{uuid.uuid4().hex[:6]}"


async def until(cond, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return
        await asyncio.sleep(0.1)
    raise AssertionError("condition not met")


class Stack:
    """Start/stop a group of workers together."""

    def __init__(self, *workers):
        self.workers = list(workers)

    async def __aenter__(self):
        for w in self.workers:
            await w.__aenter__()
        return self

    async def __aexit__(self, *a):
        for w in reversed(self.workers):
            await w.__aexit__(*a)


# ============================================================ use case 1: routing
@workflow.defn
class WrongQueue:
    @workflow.run
    async def run(self) -> str:
        # "media" workers only register get_host_queue, not render_on_gpu
        return await workflow.execute_activity(
            routing.render_on_gpu, "x", task_queue=routing.SHARED_QUEUE,
            schedule_to_close_timeout=timedelta(seconds=4))


def gpu_worker(client):
    return Worker(client, task_queue=routing.GPU_QUEUE, activities=[routing.render_on_gpu])


async def run_media(client, name):
    return await client.execute_workflow(routing.MediaWorkflow.run, name, id=uid("media"), task_queue=routing.SHARED_QUEUE)


async def start_media(client, name):
    return await client.start_workflow(routing.MediaWorkflow.run, name, id=uid("media"), task_queue=routing.SHARED_QUEUE)


async def own_client(env):
    """A client with its OWN runtime: stands in for 'a separate machine'. (One runtime refuses two workers with the
    same task types on one queue, which is fine in production where each host is its own process.)"""
    cfg = env.client.service_client.config
    return await Client.connect(cfg.target_host, namespace=env.client.namespace, runtime=Runtime(telemetry=TelemetryConfig()))


async def media_workers(env, *hosts, ghost=None):
    client = env.client
    ws = [gpu_worker(client), Worker(client, task_queue=routing.SHARED_QUEUE, workflows=[routing.MediaWorkflow])]
    for h in hosts:
        ws += routing.host_workers(await own_client(env), h)
    if ghost:
        ws += routing.host_workers(await own_client(env), ghost, reachable=False)
    return Stack(*ws)


async def test_file_steps_stay_on_one_host_and_gpu_work_goes_to_the_gpu_queue(env):
    a, b = routing.Host("a"), routing.Host("b")
    async with await media_workers(env, a, b):
        results = await asyncio.gather(*[run_media(env.client, f"f{i}.mp4") for i in range(8)])
    for r in results:
        assert r.rendered.startswith("rendered:")
    for h in (a, b):
        by_file = {}
        steps = [s for s, _ in h.log]
        assert steps.count("download") == steps.count("process") == steps.count("upload")  # each host saw whole jobs only
    assert len(a.log) + len(b.log) == 8 * 3
    assert {r.host for r in results} <= {"a", "b"}


async def test_a_host_that_vanished_after_the_lookup_is_retried_on_another_host(env):
    good, ghost = routing.Host("good"), routing.Host("ghost")
    async with await media_workers(env, good, ghost=ghost):
        results = await asyncio.gather(*[run_media(env.client, f"g{i}.mp4") for i in range(6)])
    assert {r.host for r in results} == {"good"}
    assert ghost.log == []  # the ghost answered lookups but never ran any file step


async def test_a_task_for_an_unregistered_activity_does_not_fail_the_workflow_it_times_out(env):
    async with Stack(Worker(env.client, task_queue="wq", workflows=[WrongQueue]),
                     Worker(env.client, task_queue=routing.SHARED_QUEUE, activities=[routing.Host("z").get_host_queue])):
        t0 = time.time()
        with pytest.raises(WorkflowFailureError) as e:
            await env.client.execute_workflow(WrongQueue.run, id=uid("wq"), task_queue="wq")
    assert isinstance(e.value.cause, ActivityError)
    print("unregistered activity ->", type(e.value.cause.cause).__name__, e.value.cause.cause, f"after {time.time() - t0:.1f}s")
    assert time.time() - t0 >= 3.0  # it kept retrying (1 s, 2 s backoff) until the Schedule-To-Close deadline
    cause = e.value.cause.cause
    assert isinstance(cause, ApplicationError) and cause.type == "NotFoundError" and "is not registered" in cause.message


# ============================================================ use case 2: shutdown and crashes
def marker(d, job, attempt, kind):
    return os.path.join(d, f"{job}.attempt{attempt}.{kind}")


async def test_graceful_shutdown_lets_the_running_activity_finish(env):
    with tempfile.TemporaryDirectory() as d:
        a = Worker(env.client, task_queue=shutdown.TASK_QUEUE, workflows=[shutdown.RenderWorkflow], activities=[shutdown.render],
                   graceful_shutdown_timeout=timedelta(seconds=10))
        await a.__aenter__()
        h = await env.client.start_workflow(shutdown.RenderWorkflow.run, args=["j1", d, 2.0], id=uid("r"), task_queue=shutdown.TASK_QUEUE)
        await until(lambda: os.path.exists(marker(d, "j1", 1, "started")))
        t0 = time.time()
        await a.__aexit__(None, None, None)  # shutdown requested mid-activity
        waited = time.time() - t0
        assert not os.path.exists(marker(d, "j1", 1, "cancelled"))
        assert waited > 0.8  # shutdown waited for the activity
        async with Worker(env.client, task_queue=shutdown.TASK_QUEUE, workflows=[shutdown.RenderWorkflow], activities=[shutdown.render]):
            assert await h.result() == "j1:attempt1"  # finished on the FIRST attempt


async def test_a_short_grace_period_cancels_the_activity_and_another_worker_retries_it(env):
    with tempfile.TemporaryDirectory() as d:
        a = Worker(env.client, task_queue=shutdown.TASK_QUEUE, workflows=[shutdown.RenderWorkflow], activities=[shutdown.render],
                   graceful_shutdown_timeout=timedelta(seconds=0.5))
        await a.__aenter__()
        h = await env.client.start_workflow(shutdown.RenderWorkflow.run, args=["j2", d, 3.0], id=uid("r"), task_queue=shutdown.TASK_QUEUE)
        await until(lambda: os.path.exists(marker(d, "j2", 1, "started")))
        await a.__aexit__(None, None, None)
        assert open(marker(d, "j2", 1, "cancelled")).read() == "worker-shutdown"  # the activity could tell why
        async with Worker(env.client, task_queue=shutdown.TASK_QUEUE, workflows=[shutdown.RenderWorkflow], activities=[shutdown.render]):
            assert await h.result() == "j2:attempt2"
        assert os.path.exists(marker(d, "j2", 2, "started"))


async def test_a_killed_worker_is_noticed_by_the_heartbeat_timeout_and_the_work_moves(env):
    with tempfile.TemporaryDirectory() as d:
        cfg = env.client.service_client.config
        proc = subprocess.Popen([sys.executable, "crashing_worker.py", cfg.target_host, env.client.namespace],
                                stdout=subprocess.PIPE, text=True)
        try:
            assert proc.stdout.readline().strip() == "ready"
            h = await env.client.start_workflow(shutdown.RenderWorkflow.run, args=["j3", d, 6.0], id=uid("r"), task_queue=shutdown.TASK_QUEUE)
            await until(lambda: os.path.exists(marker(d, "j3", 1, "started")))
            pid_first = open(marker(d, "j3", 1, "started")).read()
            async with Worker(env.client, task_queue=shutdown.TASK_QUEUE, workflows=[shutdown.RenderWorkflow], activities=[shutdown.render]):
                t0 = time.time()
                proc.send_signal(signal.SIGKILL)  # no shutdown, no cleanup: the process just disappears
                await until(lambda: os.path.exists(marker(d, "j3", 2, "started")), timeout=60)
                detected = time.time() - t0
                assert await h.result() == "j3:attempt2"
            assert open(marker(d, "j3", 2, "started")).read() == str(os.getpid())  # ran in THIS process
            assert pid_first != str(os.getpid())
            print(f"killed worker -> attempt 2 started after {detected:.1f}s (heartbeat timeout 2s)")
            assert detected < 30
        finally:
            proc.kill()


# ============================================================ use case 3: tuning with metrics
PORT = 9464


def scrape():
    return urllib.request.urlopen(f"http://127.0.0.1:{PORT}/metrics").read().decode()


def metric(text, name, **labels):
    """Sum of all samples of `name` whose labels include `labels`."""
    total = 0.0
    for line in text.splitlines():
        if not line.startswith(name + "{") and not line.startswith(name + " "):
            continue
        if all(f'{k}="{v}"' in line for k, v in labels.items()):
            total += float(line.rsplit(" ", 1)[1])
    return total


@pytest.fixture(scope="module")
async def menv():
    rt = tuning.metrics_runtime(PORT)
    async with await WorkflowEnvironment.start_local(runtime=rt) as e:
        yield e


async def test_metric_names_in_the_docs_exist(menv):
    q = uid("names")
    async with tuning.tuned_worker(menv.client, q):
        await menv.client.execute_workflow(tuning.WorkWorkflow.run, 0.1, id=uid("w"), task_queue=q)
        text = scrape()
    names = set(re.findall(r"^(temporal_[a-z_]+?)(?:_bucket|_sum|_count)?[{ ]", text, re.M))
    print(sorted(n for n in names if any(k in n for k in ("slots", "sticky", "poller", "schedule_to_start", "workflow_task_execution"))))
    for want in ("temporal_worker_task_slots_available", "temporal_sticky_cache_size", "temporal_num_pollers",
                 "temporal_activity_schedule_to_start_latency", "temporal_workflow_task_execution_latency"):
        assert want in names, want


async def run_batch(client, queue, n, seconds):
    tuning.RUNNING.update(now=0, peak=0)
    return await asyncio.gather(*[client.execute_workflow(tuning.WorkWorkflow.run, seconds, id=uid("b"), task_queue=queue) for _ in range(n)])


async def avg_s2s(queue):
    t = scrape()
    return metric(t, "temporal_activity_schedule_to_start_latency_sum", task_queue=queue), \
        metric(t, "temporal_activity_schedule_to_start_latency_count", task_queue=queue)


async def test_too_few_activity_slots_show_up_as_schedule_to_start_latency_and_zero_free_slots(menv):
    small, big = uid("small"), uid("big")
    async with tuning.tuned_worker(menv.client, small, max_concurrent_activities=2):
        batch = asyncio.create_task(run_batch(menv.client, small, 6, 1.0))
        await asyncio.sleep(1.2)  # mid-run
        free = metric(scrape(), "temporal_worker_task_slots_available", worker_type="ActivityWorker", task_queue=small)
        await batch
        assert tuning.RUNNING["peak"] == 2
        s, c = await avg_s2s(small)
    small_avg = s / c
    async with tuning.tuned_worker(menv.client, big, max_concurrent_activities=10):
        await run_batch(menv.client, big, 6, 1.0)
        assert tuning.RUNNING["peak"] == 6
        s, c = await avg_s2s(big)
    big_avg = s / c
    print(f"free activity slots mid-run (2 slots): {free}; avg schedule-to-start {small_avg:.0f} ms (2 slots) vs {big_avg:.1f} ms (10 slots)")
    assert free == 0
    assert small_avg > 800 and big_avg < 400  # the metric is in milliseconds


async def poke_all(client, handles, rounds=2):
    for _ in range(rounds):
        for h in handles:
            await h.signal(tuning.WaitWorkflow.poke)
            await asyncio.sleep(0.05)


async def run_waiters(client, queue, n=4):
    hs = [await client.start_workflow(tuning.WaitWorkflow.run, id=uid("wait"), task_queue=queue) for _ in range(n)]
    await asyncio.sleep(0.5)
    await poke_all(client, hs)
    return [await h.result() for h in hs]


async def test_a_tiny_sticky_cache_causes_misses_and_replays_but_never_wrong_results(menv):
    tiny, roomy = uid("tiny"), uid("roomy")
    async with tuning.tuned_worker(menv.client, tiny, max_cached_workflows=1):
        assert await run_waiters(menv.client, tiny) == [2, 2, 2, 2]
        t = scrape()
        tiny_miss = metric(t, "temporal_sticky_cache_miss", task_queue=tiny)
        tiny_hit = metric(t, "temporal_sticky_cache_hit", task_queue=tiny)
    async with tuning.tuned_worker(menv.client, roomy, max_cached_workflows=100):
        assert await run_waiters(menv.client, roomy) == [2, 2, 2, 2]
        t = scrape()
        roomy_miss = metric(t, "temporal_sticky_cache_miss", task_queue=roomy)
        roomy_hit = metric(t, "temporal_sticky_cache_hit", task_queue=roomy)
    print(f"cache=1: miss {tiny_miss} hit {tiny_hit}; cache=100: miss {roomy_miss} hit {roomy_hit}")
    assert tiny_miss > roomy_miss
    assert roomy_hit > tiny_hit
