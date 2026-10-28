import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './fanout.activities';
import { TASK_QUEUE } from './fanout';

/** The API only tolerates `maxConcurrent` callers (and `perSecond` calls); enforce that at the worker. */
export function makeWorker(connection: NativeConnection, opts: { maxConcurrent?: number; perSecond?: number } = {}) {
  return Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve('./fanout'),
    activities,
    maxConcurrentActivityTaskExecutions: opts.maxConcurrent ?? 5, // at most N activities run at once on this worker
    maxActivitiesPerSecond: opts.perSecond, // and at most N start per second
  });
}
