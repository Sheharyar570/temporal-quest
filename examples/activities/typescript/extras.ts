// Test-only workflows that verify claims made in the lesson text.
import { proxyActivities, proxyLocalActivities } from '@temporalio/workflow';
import type * as self from './extras.activities';

const acts = proxyActivities<typeof self>({ startToCloseTimeout: '30s', heartbeatTimeout: '1s', cancellationType: 'TRY_CANCEL' as any, retry: { maximumAttempts: 1 } });
export async function oneActivity(name: 'slowNoHeartbeat' | 'slowWithHeartbeat'): Promise<string> { await acts[name](); return 'ok'; }
export async function queueDeadline(): Promise<string> {
  const { anything } = proxyActivities<{ anything(): Promise<void> }>({
    taskQueue: 'nobody-listens', scheduleToStartTimeout: '1s', startToCloseTimeout: '10s',
    retry: { maximumAttempts: 5, initialInterval: '100ms' },
  });
  await anything();
  return 'unreachable';
}
export async function localAndAsync(mode: 'local' | 'async'): Promise<string> {
  if (mode === 'local') {
    const { quick } = proxyLocalActivities<typeof self>({ startToCloseTimeout: '5s' });
    return String(await quick(21));
  }
  const { waitForCallback } = proxyActivities<typeof self>({ startToCloseTimeout: '30s', retry: { maximumAttempts: 1 } });
  return waitForCallback();
}
