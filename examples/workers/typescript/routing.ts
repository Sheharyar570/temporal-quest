/* Use case 1 (Medium): routing work with Task Queues: a GPU queue for capability, and a per-host queue for file affinity. */
import { ActivityFailure, proxyActivities } from '@temporalio/workflow';
import type * as acts from './routing.activities';
import type { Host } from './routing.activities';

export const SHARED_QUEUE = 'media'; // every host polls this one, but only for getHostQueue
export const GPU_QUEUE = 'media-gpu'; // only GPU machines poll this one

type HostActs = ReturnType<Host['hostActivities']>;
const shared = proxyActivities<ReturnType<Host['sharedActivities']>>({ taskQueue: SHARED_QUEUE, startToCloseTimeout: '10 seconds' });
const gpu = proxyActivities<typeof acts>({ taskQueue: GPU_QUEUE, startToCloseTimeout: '10 seconds' });

export async function mediaWorkflow(name: string): Promise<{ host: string; rendered: string }> {
  let host: string | undefined;
  for (let i = 0; i < 4 && !host; i++) { // a dead host must not strand the job: pick another one
    const queue = await shared.getHostQueue();
    // affinity: the next three steps must run on the machine that holds the file
    const onHost = proxyActivities<HostActs>({
      taskQueue: queue, startToCloseTimeout: '10 seconds',
      scheduleToStartTimeout: '2 seconds', // fail fast if that host is gone
    });
    try {
      const path = await onHost.process(await onHost.download(name));
      host = await onHost.upload(path);
    } catch (e) {
      if (!(e instanceof ActivityFailure)) throw e;
    }
  }
  if (!host) throw new Error('no reachable host');
  // capability routing: only the GPU queue's workers know how to do this
  return { host, rendered: await gpu.renderOnGpu(name) };
}
