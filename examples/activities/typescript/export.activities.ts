import { activityInfo, cancelled, CancelledFailure, heartbeat } from '@temporalio/activity';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stand-in for object storage plus a lock service. */
class FakeStorage {
  written: number[] = [];
  events: string[] = [];
  hangAt: number | null = null; // make the first write of this chunk wedge
  chunkMs = 0;

  async writeChunk(_exportId: string, i: number): Promise<void> {
    if (this.hangAt === i) {
      this.hangAt = null; // wedge only once
      this.events.push('hang at ' + i);
      await sleep(30_000); // a stuck call: no progress, no heartbeats
    }
    await sleep(this.chunkMs);
    this.written.push(i);
  }
  async releaseLock(exportId: string): Promise<void> {
    this.events.push('lock released for ' + exportId);
  }
}
export const storage = new FakeStorage();

export interface ExportRequest {
  exportId: string;
  totalChunks: number;
}
export interface ExportResult {
  resumedFrom: number; // first chunk THIS attempt processed
  attempt: number;
  chunks: number;
}

export async function exportChunks(req: ExportRequest): Promise<ExportResult> {
  const info = activityInfo();
  // Heartbeat details survive failed attempts: resume right after the last chunk reported as done.
  const start = typeof info.heartbeatDetails === 'number' ? info.heartbeatDetails + 1 : 0;
  try {
    for (let i = start; i < req.totalChunks; i++) {
      // Race the work against cancellation: a plain promise would not notice it.
      await Promise.race([storage.writeChunk(req.exportId, i), cancelled()]); // writes must be idempotent
      heartbeat(i); // "chunk i is done": proves liveness, saves progress, and receives cancellation
    }
  } catch (e) {
    if (e instanceof CancelledFailure) await storage.releaseLock(req.exportId); // clean up, then let it continue
    throw e;
  }
  return { resumedFrom: start, attempt: info.attempt, chunks: req.totalChunks };
}
