import { Runtime, Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './tuning.activities';

/** Expose the SDK's metrics at http://127.0.0.1:<port>/metrics. Call this BEFORE creating any worker or connection. */
export function installMetrics(port: number) {
  Runtime.install({ telemetryOptions: { metrics: { prometheus: { bindAddress: `127.0.0.1:${port}` } } } });
}

export function tunedWorker(connection: NativeConnection, taskQueue: string, o: { maxConcurrentActivities?: number; maxCachedWorkflows?: number } = {}) {
  return Worker.create({
    connection, taskQueue, workflowsPath: require.resolve('./tuning'), activities,
    maxConcurrentActivityTaskExecutions: o.maxConcurrentActivities ?? 100, // activity slots (default 100 in TypeScript)
    maxCachedWorkflows: o.maxCachedWorkflows, // sticky cache (default: dynamic, based on RAM)
  });
}
