import { ActivityFailure, ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type * as activities from './fanout.activities';

export const TASK_QUEUE = 'profiles';

const { fetchProfile } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: { initialInterval: '1s', maximumAttempts: 5 },
});

export interface SyncResult {
  profiles: Record<string, string>;
  missing: string[];
  failed: string[];
}

export async function profileSyncWorkflow(userIds: string[]): Promise<SyncResult> {
  // allSettled: one bad user must not lose the other results
  const results = await Promise.allSettled(userIds.map((id) => fetchProfile(id)));
  const out: SyncResult = { profiles: {}, missing: [], failed: [] };
  results.forEach((r, i) => {
    const id = userIds[i];
    if (r.status === 'fulfilled') out.profiles[id] = r.value;
    else if (r.reason instanceof ActivityFailure && r.reason.cause instanceof ApplicationFailure && r.reason.cause.type === 'NotFound') out.missing.push(id);
    else out.failed.push(id);
  });
  return out;
}
