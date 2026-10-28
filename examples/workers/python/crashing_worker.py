"""Run a worker in its own OS process so a test can SIGKILL it. usage: crashing_worker.py <address> <namespace>"""
import asyncio
import sys

from temporalio.client import Client
from temporalio.worker import Worker

import shutdown


async def main() -> None:
    client = await Client.connect(sys.argv[1], namespace=sys.argv[2])
    async with Worker(client, task_queue=shutdown.TASK_QUEUE, workflows=[shutdown.RenderWorkflow], activities=[shutdown.render]):
        print("ready", flush=True)
        await asyncio.Event().wait()


asyncio.run(main())
