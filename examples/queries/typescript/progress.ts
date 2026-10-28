import { defineQuery, proxyActivities, setHandler } from '@temporalio/workflow';
import type * as activities from './progress.activities';

export const TASK_QUEUE = 'imports';
const MAX_RECENT_ERRORS = 5; // keep query payloads small and bounded

const { importChunk } = proxyActivities<typeof activities>({ startToCloseTimeout: '30 seconds' });

export interface ImportInput {
  totalRecords: number;
  chunkSize?: number;
}
export interface Progress {
  total: number;
  done: number;
  failed: number;
  percent: number;
  chunksDone: number;
  recentErrors: string[];
  elapsedSeconds: number;
  etaSeconds: number | null;
  finished: boolean;
}

export const progressQuery = defineQuery<Progress>('progress');

export async function importWorkflow(input: ImportInput): Promise<Progress> {
  const total = input.totalRecords;
  const chunkSize = input.chunkSize ?? 100;
  const startedAt = Date.now();
  let done = 0, failed = 0, chunksDone = 0, finished = false;
  let recentErrors: string[] = [];

  // O(1): everything is kept in counters, nothing is computed over big collections.
  const progress = (): Progress => {
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const processed = done + failed;
    const etaSeconds = finished || processed === 0 ? null : (elapsedSeconds / processed) * (total - processed);
    return {
      total, done, failed, chunksDone, recentErrors: [...recentErrors], elapsedSeconds, etaSeconds, finished,
      percent: total ? Math.round((1000 * processed) / total) / 10 : 100,
    };
  };
  setHandler(progressQuery, progress);

  for (let start = 0; start < total; start += chunkSize) {
    const size = Math.min(chunkSize, total - start);
    const r = await importChunk(start, size);
    done += r.ok;
    failed += r.failed;
    chunksDone++;
    recentErrors = [...recentErrors, ...r.errors].slice(-MAX_RECENT_ERRORS);
  }
  finished = true;
  return progress();
}
